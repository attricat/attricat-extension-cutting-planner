//! What to cut: open orders, and the pieces of the chosen orders grouped by
//! the bars or sheets they can be cut from.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::config::{Config, PieceSource};
use crate::host::{ReadRecord, Reader};
use crate::text;

/// The most orders `list-orders` reads.
const MAX_ORDERS: usize = 300;

#[derive(Serialize)]
pub struct OrderSummary {
    id: String,
    number: String,
    customer: Option<String>,
    status: Option<String>,
    due_date: Option<String>,
}

#[derive(Serialize)]
pub struct OrderList {
    orders: Vec<OrderSummary>,
    truncated: bool,
}

pub fn list_orders(config: &Config, reader: &mut Reader) -> Result<OrderList, String> {
    let ids = reader.record_ids(&config.orders.blueprint, MAX_ORDERS + 1)?;
    let truncated = ids.len() > MAX_ORDERS;
    let mut orders = Vec::new();
    for id in ids.iter().take(MAX_ORDERS) {
        let record = reader.record(id)?;
        let customer = reader
            .target(&record, &config.orders.customer)?
            .map(|c| c.display.clone());
        let values = &record.values;
        let status = values.text(&config.orders.status);
        let open = &config.orders.open_statuses;
        if !open.is_empty() && !status.as_ref().is_some_and(|s| open.contains(s)) {
            continue;
        }
        orders.push(OrderSummary {
            id: id.clone(),
            number: values
                .text(&config.orders.number)
                .unwrap_or_else(|| id.chars().take(8).collect()),
            customer,
            status,
            due_date: values.text(&config.orders.due_date),
        });
    }
    orders.sort_by(|a, b| a.due_date.cmp(&b.due_date).then(a.number.cmp(&b.number)));
    Ok(OrderList { orders, truncated })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DemandRequest {
    order_ids: Vec<String>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Bar,
    Sheet,
}

#[derive(Serialize)]
pub struct Piece {
    line_id: String,
    order_id: String,
    order_number: String,
    customer: Option<String>,
    item_id: String,
    item_label: String,
    length: f64,
    /// Sheets only.
    width: Option<f64>,
    quantity: u32,
    rotate: bool,
}

#[derive(Serialize)]
pub struct Group {
    key: String,
    kind: Kind,
    label: String,
    /// Sheets only: for choosing a machine by its thickness range.
    thickness: Option<f64>,
    pieces: Vec<Piece>,
}

#[derive(Serialize)]
pub struct Skipped {
    line_id: String,
    order_number: String,
    item_label: String,
    reason: String,
}

/// A shaped part: listed apart, for the laser's or plasma's CAM software.
#[derive(Serialize)]
pub struct Shaped {
    line_id: String,
    order_number: String,
    item_label: String,
    group: String,
    length: f64,
    width: f64,
    quantity: u32,
}

#[derive(Serialize)]
pub struct Demand {
    groups: Vec<Group>,
    shaped: Vec<Shaped>,
    skipped: Vec<Skipped>,
}

/// The matching key and label of a bar or sheet (or a piece's
/// specification): the attributes that must agree, joined.
pub fn group_of(
    config: &Config,
    reader: &mut Reader,
    kind: Kind,
    record: &ReadRecord,
) -> Result<Option<(String, String)>, String> {
    let (codes, thickness) = match kind {
        Kind::Bar => match &config.bars {
            Some(bars) => (&bars.section, None),
            None => return Ok(None),
        },
        Kind::Sheet => match &config.sheets {
            Some(sheets) => (&sheets.matches, Some(sheets.thickness.as_str())),
            None => return Ok(None),
        },
    };
    let mut keys = vec![match kind {
        Kind::Bar => "bar".to_owned(),
        Kind::Sheet => "sheet".to_owned(),
    }];
    let mut labels = Vec::new();
    for code in codes {
        let Some((key, label)) = reader.key_and_label(record, code)? else {
            return Ok(None);
        };
        keys.push(key);
        labels.push(if Some(code.as_str()) == thickness {
            format!("{label} mm")
        } else {
            label
        });
    }
    Ok(Some((keys.join("\u{1f}"), labels.join(" · "))))
}

/// The record that carries a piece's dimensions.
fn specification(
    reader: &mut Reader,
    source: &PieceSource,
    item: &std::rc::Rc<ReadRecord>,
) -> Result<Option<std::rc::Rc<ReadRecord>>, String> {
    match &source.via {
        Some(via) => reader.target(item, via),
        None => Ok(Some(item.clone())),
    }
}

pub fn load_demand(
    config: &Config,
    reader: &mut Reader,
    request: DemandRequest,
) -> Result<Demand, String> {
    let lines_config = &config.order_lines;
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    let mut shaped = Vec::new();
    let mut skipped = Vec::new();

    for order_id in request.order_ids.iter().take(50) {
        let order = reader.record(order_id)?;
        let order_number = order.values.text(&config.orders.number).unwrap_or_default();
        let customer = reader
            .target(&order, &config.orders.customer)?
            .map(|c| c.display.clone());
        for line_id in reader.incoming(order_id, &lines_config.blueprint, &lines_config.order)? {
            let line = reader.record(&line_id)?;
            let Some(item) = reader.target(&line, &lines_config.item)? else {
                continue;
            };
            let item_id = line
                .values
                .target(&lines_config.item)
                .unwrap_or_default()
                .to_owned();
            let mut skip = |reason: &str| {
                skipped.push(Skipped {
                    line_id: line_id.clone(),
                    order_number: order_number.clone(),
                    item_label: item.display.clone(),
                    reason: reason.to_owned(),
                })
            };
            let quantity = line.values.number(&lines_config.quantity).unwrap_or(0.0);
            if quantity <= 0.0 || quantity.fract() != 0.0 {
                skip(text::NOT_WHOLE_PIECES);
                continue;
            }
            let code = &item.blueprint.code;
            let bar_source = config
                .bars
                .as_ref()
                .and_then(|b| b.pieces.iter().find(|p| &p.blueprint == code));
            let sheet_source = config
                .sheets
                .as_ref()
                .and_then(|s| s.pieces.iter().find(|p| &p.blueprint == code));
            let (kind, source) = match (bar_source, sheet_source) {
                (Some(source), _) => (Kind::Bar, source),
                (None, Some(source)) => (Kind::Sheet, source),
                (None, None) => {
                    skip(text::NOT_CUT);
                    continue;
                }
            };
            let Some(spec) = specification(reader, source, &item)? else {
                skip(text::NO_SPECIFICATION);
                continue;
            };
            let (length_code, width_code) = match (kind, &config.bars, &config.sheets) {
                (Kind::Bar, Some(bars), _) => (&bars.length, None),
                (Kind::Sheet, _, Some(sheets)) => (&sheets.length, Some(&sheets.width)),
                _ => continue,
            };
            let Some(length) = spec.values.number(length_code).filter(|l| *l > 0.0) else {
                skip(text::NO_LENGTH);
                continue;
            };
            let width = match width_code {
                Some(code) => match spec.values.number(code).filter(|w| *w > 0.0) {
                    Some(width) => Some(width),
                    None => {
                        skip(text::NO_WIDTH);
                        continue;
                    }
                },
                None => None,
            };
            let Some((key, label)) = group_of(config, reader, kind, &spec)? else {
                skip(text::NO_SECTION);
                continue;
            };
            let sheets = config.sheets.as_ref().filter(|_| kind == Kind::Sheet);
            let flag = |code: Option<&String>| code.and_then(|c| spec.values.boolean(c));
            if flag(sheets.and_then(|s| s.shaped.as_ref())) == Some(true) {
                shaped.push(Shaped {
                    line_id: line_id.clone(),
                    order_number: order_number.clone(),
                    item_label: item.display.clone(),
                    group: label,
                    length,
                    width: width.unwrap_or(0.0),
                    quantity: quantity as u32,
                });
                continue;
            }
            let rotate =
                sheets.is_some() && flag(sheets.and_then(|s| s.rotate.as_ref())) != Some(false);
            let thickness = sheets.and_then(|s| spec.values.number(&s.thickness));
            groups
                .entry(key.clone())
                .or_insert_with(|| Group {
                    key,
                    kind,
                    label,
                    thickness,
                    pieces: Vec::new(),
                })
                .pieces
                .push(Piece {
                    line_id: line_id.clone(),
                    order_id: order_id.clone(),
                    order_number: order_number.clone(),
                    customer: customer.clone(),
                    item_id: item_id.clone(),
                    item_label: item.display.clone(),
                    length,
                    width,
                    quantity: quantity as u32,
                    rotate,
                });
        }
    }
    let mut groups: Vec<Group> = groups.into_values().collect();
    groups.sort_by(|a, b| a.kind.cmp(&b.kind).then(a.label.cmp(&b.label)));
    Ok(Demand {
        groups,
        shaped,
        skipped,
    })
}
