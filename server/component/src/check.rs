//! Whether a saved plan still matches its inputs: the order lines' quantities
//! and the stock it needs. Only plans without production orders can go out
//! of date; once orders exist, using up the stock is the point.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::host::{self, Reader};
use crate::plans;
use crate::text;

#[derive(Deserialize)]
struct Plan {
    #[serde(default)]
    groups: Vec<Group>,
    #[serde(default)]
    production_orders: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
struct Group {
    stock: Vec<Stock>,
    pieces: Vec<Piece>,
    layouts: Vec<Layout>,
}

#[derive(Deserialize)]
struct Stock {
    item_id: String,
    label: String,
    #[serde(default)]
    unlimited: bool,
}

#[derive(Deserialize)]
struct Piece {
    line_id: String,
    item_label: String,
    quantity: f64,
}

#[derive(Deserialize)]
struct Layout {
    stock: usize,
    count: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckRequest {
    plan_id: String,
}

#[derive(Serialize)]
pub struct Checked {
    stale: bool,
    reasons: Vec<String>,
}

pub fn check(
    config: &Config,
    reader: &mut Reader,
    request: CheckRequest,
) -> Result<Checked, String> {
    let fresh = Checked {
        stale: false,
        reasons: Vec::new(),
    };
    if !plans::valid_id(&request.plan_id) {
        return Ok(fresh);
    }
    let Some(stored) = host::storage_get(&plans::key(&request.plan_id))? else {
        return Ok(fresh);
    };
    let plan: Plan =
        serde_json::from_value(stored.value).map_err(|e| format!("stored plan: {e}"))?;
    if !plan.production_orders.is_empty() {
        return Ok(fresh);
    }
    let mut reasons = Vec::new();
    for group in &plan.groups {
        for piece in &group.pieces {
            let now = match reader.record(&piece.line_id) {
                Ok(line) => line.values.number(&config.order_lines.quantity),
                Err(_) => None,
            };
            match now {
                Some(quantity) if (quantity - piece.quantity).abs() < 1e-9 => {}
                Some(quantity) => reasons.push(text::stale_quantity(
                    &piece.item_label,
                    piece.quantity,
                    quantity,
                )),
                None => reasons.push(text::stale_line_gone(&piece.item_label)),
            }
        }
    }

    // What the plan needs of each limited stock item, against what is free now.
    let mut needed: HashMap<&str, (u32, &str)> = HashMap::new();
    for group in &plan.groups {
        for layout in &group.layouts {
            let Some(stock) = group.stock.get(layout.stock) else {
                continue;
            };
            if stock.unlimited {
                continue;
            }
            needed.entry(&stock.item_id).or_insert((0, &stock.label)).0 += layout.count;
        }
    }
    if !needed.is_empty() {
        let levels = &config.stock_levels;
        let mut free: HashMap<String, f64> = HashMap::new();
        for id in reader.record_ids(&levels.blueprint, 2000)? {
            let level = reader.record(&id)?;
            let Some(item) = level.values.target(&levels.item).map(str::to_owned) else {
                continue;
            };
            if !needed.contains_key(item.as_str()) {
                continue;
            }
            let mut quantity = level.values.number(&levels.quantity).unwrap_or(0.0)
                - levels
                    .reserved
                    .as_ref()
                    .and_then(|c| level.values.number(c))
                    .unwrap_or(0.0);
            if let Some(per_piece) = &levels.per_piece {
                let item_record = reader.record(&item)?;
                match item_record.values.number(per_piece).filter(|w| *w > 0.0) {
                    Some(weight) => quantity /= weight,
                    None => continue,
                }
            }
            *free.entry(item).or_default() += quantity;
        }
        let mut short: Vec<_> = needed
            .iter()
            .filter(|(item, (count, _))| {
                free.get(**item).copied().unwrap_or(0.0).floor() < f64::from(*count)
            })
            .map(|(item, (count, label))| {
                text::stale_stock(
                    label,
                    *count,
                    free.get(*item).copied().unwrap_or(0.0).floor().max(0.0) as u32,
                )
            })
            .collect();
        short.sort();
        reasons.extend(short);
    }
    Ok(Checked {
        stale: !reasons.is_empty(),
        reasons,
    })
}
