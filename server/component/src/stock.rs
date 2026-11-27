//! What to cut from: bars, sheets and remnants in stock for the requested
//! groups, and the machines that cut them.

use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::demand::{Kind, group_of};
use crate::host::{ReadRecord, Reader};

const MAX_STOCK_RECORDS: usize = 2000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StockRequest {
    group_keys: Vec<String>,
}

#[derive(Serialize)]
pub struct Piece {
    item_id: String,
    label: String,
    length: f64,
    /// Sheets only.
    width: Option<f64>,
    /// Whole pieces free to use (stock less reservations).
    available: u32,
    /// Weight of one piece in kilograms, when known.
    weight: Option<f64>,
    remnant: bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Process {
    Saw,
    Guillotine,
    Laser,
    Plasma,
}

#[derive(Serialize)]
pub struct Machine {
    id: String,
    name: String,
    process: Process,
    kerf: f64,
    spacing: f64,
    edge_trim: f64,
    guillotine_only: bool,
    min_thickness: Option<f64>,
    max_thickness: Option<f64>,
    max_width: Option<f64>,
    max_length: Option<f64>,
}

#[derive(Serialize)]
pub struct Stock {
    /// Bars or sheets per group key, remnants first.
    groups: BTreeMap<String, Vec<Piece>>,
    machines: Vec<Machine>,
    truncated: bool,
}

/// Which kind a stock record's item is, and whether it is a remnant.
fn classify(config: &Config, item: &ReadRecord) -> Option<(Kind, bool)> {
    let code = &item.blueprint.code;
    if let Some(remnants) = config.remnants.as_ref().filter(|r| &r.blueprint == code) {
        let has_width = item.values.number(&remnants.width).is_some_and(|w| w > 0.0);
        return match (has_width, &config.sheets, &config.bars) {
            (true, Some(_), _) => Some((Kind::Sheet, true)),
            (false, _, Some(_)) => Some((Kind::Bar, true)),
            _ => None,
        };
    }
    if config.bars.as_ref().is_some_and(|b| b.stock.contains(code)) {
        return Some((Kind::Bar, false));
    }
    if config
        .sheets
        .as_ref()
        .is_some_and(|s| s.stock.contains(code))
    {
        return Some((Kind::Sheet, false));
    }
    None
}

/// Length, width and weight of a bar, sheet or remnant.
fn dimensions(
    config: &Config,
    reader: &mut Reader,
    kind: Kind,
    remnant: bool,
    item: &ReadRecord,
) -> Result<Option<(f64, Option<f64>, Option<f64>)>, String> {
    let r = config.remnants.as_ref().filter(|_| remnant);
    let (length_code, width_code, weight_code) = match kind {
        Kind::Bar => {
            let bars = config.bars.as_ref().ok_or("bars not configured")?;
            (
                r.map_or(&bars.length, |r| &r.length),
                None,
                r.map_or(bars.weight.as_ref(), |r| r.weight.as_ref()),
            )
        }
        Kind::Sheet => {
            let sheets = config.sheets.as_ref().ok_or("sheets not configured")?;
            (
                r.map_or(&sheets.length, |r| &r.length),
                Some(r.map_or(&sheets.width, |r| &r.width)),
                r.map_or(sheets.weight.as_ref(), |r| r.weight.as_ref()),
            )
        }
    };
    let Some(length) = item.values.number(length_code).filter(|l| *l > 0.0) else {
        return Ok(None);
    };
    let width = match width_code {
        Some(code) => match item.values.number(code).filter(|w| *w > 0.0) {
            Some(width) => Some(width),
            None => return Ok(None),
        },
        None => None,
    };
    let mut weight = weight_code
        .and_then(|code| item.values.number(code))
        .filter(|w| *w > 0.0);
    if weight.is_none() && kind == Kind::Sheet {
        weight = sheet_weight(config, reader, item, length, width.unwrap_or(0.0))?;
    }
    Ok(Some((length, width, weight)))
}

/// A sheet's weight from its dimensions and its grade's density (kg/dm³).
fn sheet_weight(
    config: &Config,
    reader: &mut Reader,
    item: &ReadRecord,
    length: f64,
    width: f64,
) -> Result<Option<f64>, String> {
    let Some(sheets) = &config.sheets else {
        return Ok(None);
    };
    let Some(density) = &sheets.density else {
        return Ok(None);
    };
    let Some(thickness) = item.values.number(&sheets.thickness) else {
        return Ok(None);
    };
    let Some(source) = reader.target(item, &density.via)? else {
        return Ok(None);
    };
    Ok(source
        .values
        .number(&density.attribute)
        .map(|d| (length * width * thickness * d / 1_000_000.0 * 1000.0).round() / 1000.0))
}

pub fn load_stock(
    config: &Config,
    reader: &mut Reader,
    request: StockRequest,
) -> Result<Stock, String> {
    let wanted: HashSet<String> = request.group_keys.into_iter().collect();
    let levels = &config.stock_levels;
    let ids = reader.record_ids(&levels.blueprint, MAX_STOCK_RECORDS + 1)?;
    let truncated = ids.len() > MAX_STOCK_RECORDS;
    let mut found: BTreeMap<String, BTreeMap<String, Piece>> = BTreeMap::new();

    for id in ids.iter().take(MAX_STOCK_RECORDS) {
        let level = reader.record(id)?;
        let Some(item) = reader.target(&level, &levels.item)? else {
            continue;
        };
        let item_id = level
            .values
            .target(&levels.item)
            .unwrap_or_default()
            .to_owned();
        let Some((kind, remnant)) = classify(config, &item) else {
            continue;
        };
        let Some((key, _)) = group_of(config, reader, kind, &item)? else {
            continue;
        };
        if !wanted.contains(&key) {
            continue;
        }
        let Some((length, width, weight)) = dimensions(config, reader, kind, remnant, &item)?
        else {
            continue;
        };
        let mut quantity = level.values.number(&levels.quantity).unwrap_or(0.0)
            - levels
                .reserved
                .as_ref()
                .and_then(|code| level.values.number(code))
                .unwrap_or(0.0);
        if levels.per_piece.is_some() {
            match weight {
                Some(unit) => quantity /= unit,
                None => continue,
            }
        }
        let available = quantity.max(0.0).floor() as u32;
        if remnant && available == 0 {
            continue;
        }
        // Several stock records of one item (per warehouse, say) add up.
        found
            .entry(key)
            .or_default()
            .entry(item_id.clone())
            .or_insert(Piece {
                item_id,
                label: item.display.clone(),
                length,
                width,
                available: 0,
                weight,
                remnant,
            })
            .available += available;
    }

    let groups = found
        .into_iter()
        .map(|(key, items)| {
            let mut list: Vec<Piece> = items.into_values().collect();
            let size = |p: &Piece| p.length * p.width.unwrap_or(1.0);
            list.sort_by(|a, b| b.remnant.cmp(&a.remnant).then(size(b).total_cmp(&size(a))));
            (key, list)
        })
        .collect();
    Ok(Stock {
        groups,
        machines: machines(config, reader)?,
        truncated,
    })
}

fn machines(config: &Config, reader: &mut Reader) -> Result<Vec<Machine>, String> {
    let m = &config.machines;
    let mut machines = Vec::new();
    for id in reader.record_ids(&m.blueprint, 200)? {
        let record = reader.record(&id)?;
        let values = &record.values;
        let value = values.text(&m.process).unwrap_or_default();
        let process = if m.processes.saw.contains(&value) {
            Process::Saw
        } else if m.processes.guillotine.contains(&value) {
            Process::Guillotine
        } else if m.processes.laser.contains(&value) {
            Process::Laser
        } else if m.processes.plasma.contains(&value) {
            Process::Plasma
        } else {
            continue;
        };
        machines.push(Machine {
            id,
            name: values.text(&m.name).unwrap_or_default(),
            process,
            kerf: values.number(&m.kerf).unwrap_or(0.0),
            spacing: values.number(&m.spacing).unwrap_or(0.0),
            edge_trim: values.number(&m.edge_trim).unwrap_or(0.0),
            guillotine_only: process == Process::Guillotine
                || values.boolean(&m.guillotine_only) == Some(true),
            min_thickness: values.number(&m.min_thickness),
            max_thickness: values.number(&m.max_thickness),
            max_width: values.number(&m.max_width),
            max_length: values.number(&m.max_length),
        });
    }
    machines.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(machines)
}
