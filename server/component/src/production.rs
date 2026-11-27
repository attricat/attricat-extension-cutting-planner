//! Turns a saved plan into production orders: one per material group, with
//! the bars or sheets used as materials, and the pieces, remnants and scrap
//! as output.
//!
//! Every intent key starts with the plan ID, so creating the orders again
//! (a retry, a second click) is `already_applied` and writes nothing new.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::Config;
use crate::host::{self, Reader};
use crate::plans::{self, ProductionRef};
use crate::text;

#[derive(Deserialize)]
pub struct Plan {
    pub id: String,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub production_orders: Vec<ProductionRef>,
}

#[derive(Deserialize)]
pub struct Group {
    pub key: String,
    #[serde(default)]
    pub label: String,
    pub machine: Option<MachineRef>,
    pub stock: Vec<StockPiece>,
    pub pieces: Vec<Piece>,
    pub layouts: Vec<Layout>,
}

#[derive(Deserialize)]
pub struct MachineRef {
    pub id: String,
}

#[derive(Deserialize)]
pub struct StockPiece {
    pub item_id: String,
    pub length: f64,
    #[serde(default)]
    pub width: Option<f64>,
    pub weight: Option<f64>,
    #[serde(default)]
    pub remnant: bool,
}

#[derive(Deserialize)]
pub struct Piece {
    pub line_id: String,
    pub order_id: String,
    pub item_id: String,
    pub length: f64,
    #[serde(default)]
    pub width: Option<f64>,
}

#[derive(Deserialize)]
pub struct PlacementRef {
    pub piece: usize,
}

#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct RemnantRef {
    pub length: f64,
    #[serde(default)]
    pub width: Option<f64>,
}

/// One bar or sheet layout repeated `count` times. Bars list the pieces in
/// `cuts`, sheets in `placements`; both index `pieces`.
#[derive(Deserialize)]
pub struct Layout {
    pub stock: usize,
    pub count: u32,
    #[serde(default)]
    pub cuts: Vec<usize>,
    #[serde(default)]
    pub placements: Vec<PlacementRef>,
    #[serde(default)]
    pub remnants: Vec<RemnantRef>,
}

impl Layout {
    fn pieces(&self) -> impl Iterator<Item = usize> + '_ {
        self.cuts
            .iter()
            .copied()
            .chain(self.placements.iter().map(|p| p.piece))
    }
}

/// Length for a bar, area for a sheet.
fn measure(length: f64, width: Option<f64>) -> f64 {
    length * width.unwrap_or(1.0)
}

/// What one group's production order is made of.
#[derive(Debug, PartialEq)]
pub struct Lines {
    /// Pieces of stock per stock entry, with one piece's weight.
    pub materials: Vec<(usize, u32, Option<f64>)>,
    /// Pieces per order line: (line, item, count).
    pub products: Vec<(String, String, u32)>,
    pub orders: Vec<String>,
    /// Remnants kept: (stock entry, size, weight), one per physical piece.
    pub remnants: Vec<(usize, RemnantRef, Option<f64>)>,
    /// Kilograms: material weight less the pieces (and the remnants when they
    /// are booked separately), when every piece of stock has a weight.
    pub scrap_kg: Option<f64>,
}

pub fn lines(group: &Group, book_remnants: bool) -> Result<Lines, String> {
    let mut materials: BTreeMap<usize, u32> = BTreeMap::new();
    let mut products: BTreeMap<usize, u32> = BTreeMap::new();
    let mut remnants = Vec::new();
    let mut scrap = 0.0;
    let mut weights_known = true;
    for layout in &group.layouts {
        let stock = group
            .stock
            .get(layout.stock)
            .ok_or("layout names unknown stock")?;
        *materials.entry(layout.stock).or_default() += layout.count;
        let mut used = 0.0;
        for index in layout.pieces() {
            let piece = group
                .pieces
                .get(index)
                .ok_or("layout names unknown piece")?;
            *products.entry(index).or_default() += layout.count;
            used += measure(piece.length, piece.width);
        }
        let whole = measure(stock.length, stock.width);
        if book_remnants {
            for remnant in &layout.remnants {
                let share = measure(remnant.length, remnant.width) / whole;
                used += measure(remnant.length, remnant.width);
                for _ in 0..layout.count {
                    remnants.push((
                        layout.stock,
                        *remnant,
                        stock.weight.map(|w| (w * share * 1000.0).round() / 1000.0),
                    ));
                }
            }
        }
        match stock.weight {
            Some(weight) if whole > 0.0 => {
                scrap += f64::from(layout.count) * weight * (1.0 - used / whole)
            }
            _ => weights_known = false,
        }
    }
    let mut orders: Vec<String> = products
        .keys()
        .map(|&i| group.pieces[i].order_id.clone())
        .collect();
    orders.sort();
    orders.dedup();
    Ok(Lines {
        materials: materials
            .into_iter()
            .map(|(i, n)| (i, n, group.stock[i].weight))
            .collect(),
        products: products
            .into_iter()
            .map(|(i, n)| {
                (
                    group.pieces[i].line_id.clone(),
                    group.pieces[i].item_id.clone(),
                    n,
                )
            })
            .collect(),
        orders,
        remnants,
        scrap_kg: (weights_known && scrap > 0.0005).then(|| (scrap * 1000.0).round() / 1000.0),
    })
}

fn scalar(code: &str, context: &str, value: Value) -> Value {
    json!({"kind": "scalar", "attribute_code": code, "context_id": context, "value": value})
}

fn link(code: &str, context: &str, target: &str) -> Value {
    json!({"kind": "relationship", "attribute_code": code, "context_id": context, "target_record_id": target})
}

fn mm(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    if rounded.fract() == 0.0 {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateRequest {
    plan_id: String,
}

#[derive(Serialize)]
pub struct Created {
    ok: bool,
    message: Option<String>,
    production_orders: Vec<ProductionRef>,
}

fn refused(message: impl Into<String>) -> Created {
    Created {
        ok: false,
        message: Some(message.into()),
        production_orders: Vec::new(),
    }
}

fn first_error(outcomes: &[host::Outcome], prefix: &str) -> Option<Created> {
    outcomes.iter().find(|o| o.error.is_some()).map(|failed| {
        host::log(
            "warn",
            &format!("{} rejected: {:?}", failed.intent_key, failed.error),
        );
        refused(format!(
            "{prefix} {}",
            failed.error.as_deref().unwrap_or("")
        ))
    })
}

pub fn create(
    config: &Config,
    reader: &mut Reader,
    request: CreateRequest,
) -> Result<Created, String> {
    if !plans::valid_id(&request.plan_id) {
        return Ok(refused(text::INVALID_PLAN_ID));
    }
    let Some(stored) = host::storage_get(&plans::key(&request.plan_id))? else {
        return Ok(refused(text::PLAN_NOT_FOUND));
    };
    let plan: Plan =
        serde_json::from_value(stored.value.clone()).map_err(|e| format!("stored plan: {e}"))?;
    if !plan.production_orders.is_empty() {
        return Ok(Created {
            ok: true,
            message: None,
            production_orders: plan.production_orders,
        });
    }
    let groups: Vec<&Group> = plan
        .groups
        .iter()
        .filter(|g| !g.layouts.is_empty())
        .collect();
    if groups.is_empty() {
        return Ok(refused(text::PLAN_EMPTY));
    }

    let production = &config.production;
    let remnant_kind = production
        .output
        .kind
        .as_ref()
        .and_then(|k| k.remnant.clone());
    let remnant_config = config
        .remnants
        .as_ref()
        .filter(|_| remnant_kind.is_some() || production.output.kind.is_none());
    let book_remnants = remnant_config.is_some();
    let context = reader.context_id.clone();
    let order_bp = reader.blueprint(&production.order.blueprint)?;
    let material_bp = reader.blueprint(&production.material.blueprint)?;
    let output_bp = reader.blueprint(&production.output.blueprint)?;
    let remnant_bp = match remnant_config {
        Some(r) => Some(reader.blueprint(&r.blueprint)?),
        None => None,
    };
    let scrap_item = match &production.scrap_item {
        Some(scrap) => reader.lookup(&scrap.blueprint, &scrap.attribute, &scrap.value)?,
        None => None,
    };
    let short: String = plan.id.chars().take(8).collect();
    let computed: Vec<Lines> = groups
        .iter()
        .map(|g| lines(g, book_remnants))
        .collect::<Result<_, _>>()?;

    // 1. The production orders, so the lines can link to them.
    let mut numbers = Vec::new();
    let mut intents = Vec::new();
    for (index, (group, lines)) in groups.iter().zip(&computed).enumerate() {
        let number = format!("PC/{short}/{}", index + 1);
        let po = &production.order;
        let mut values = vec![scalar(&po.number, &context, json!(number))];
        if let Some(status) = po.initial_status() {
            values.push(scalar(&po.status, &context, json!(status)));
        }
        if let Some(code) = &po.plan {
            values.push(scalar(code, &context, json!(plan.id)));
        }
        if let Some(machine) = &group.machine {
            values.push(link(&po.machine, &context, &machine.id));
        }
        if let Some(code) = &po.customer_orders {
            values.extend(lines.orders.iter().map(|order| link(code, &context, order)));
        }
        intents.push(json!({
            "kind": "create",
            "intent_key": format!("{}:po:{index}", plan.id),
            "blueprint_id": order_bp.id,
            "blueprint_version": order_bp.version,
            "values": values,
        }));
        numbers.push(number);
    }
    let outcomes = host::apply_batch(&format!("{}:orders", plan.id), intents)?;
    if let Some(refusal) = first_error(&outcomes, text::PRODUCTION_ORDER_REJECTED) {
        return Ok(refusal);
    }
    let order_ids: Vec<String> = outcomes
        .iter()
        .map(|o| o.record_id.clone().unwrap_or_default())
        .collect();

    // 2. A record per remnant kept, with the attributes of its bar or sheet.
    let mut remnant_ids: Vec<Vec<String>> = vec![Vec::new(); groups.len()];
    if let (Some(rc), Some(rbp)) = (remnant_config, &remnant_bp) {
        let mut intents = Vec::new();
        let mut owners = Vec::new();
        for (index, (group, lines)) in groups.iter().zip(&computed).enumerate() {
            for (n, (stock_index, size, weight)) in lines.remnants.iter().enumerate() {
                let stock = &group.stock[*stock_index];
                let source = reader.record(&stock.item_id)?;
                let dims = match size.width {
                    Some(width) => format!("{} × {} mm", mm(size.length), mm(width)),
                    None => format!("{} mm", mm(size.length)),
                };
                let mut values = vec![
                    scalar(
                        &rc.name,
                        &context,
                        json!(format!("{} {} {dims}", text::REMNANT, group.label)),
                    ),
                    scalar(&rc.length, &context, json!(size.length)),
                ];
                if let Some(width) = size.width {
                    values.push(scalar(&rc.width, &context, json!(width)));
                }
                if let (Some(code), Some(weight)) = (&rc.weight, weight) {
                    values.push(scalar(code, &context, json!(weight)));
                }
                if let Some(code) = &rc.source {
                    // A remnant cut from a remnant keeps the original material.
                    let origin = if stock.remnant {
                        source.values.target(code).map(str::to_owned)
                    } else {
                        Some(stock.item_id.clone())
                    };
                    if let Some(origin) = origin {
                        values.push(link(code, &context, &origin));
                    }
                }
                for code in &rc.copy {
                    if let Some(target) = source.values.target(code) {
                        values.push(link(code, &context, target));
                    } else if let Some(value) = source.values.scalar(code) {
                        values.push(scalar(code, &context, value));
                    }
                }
                intents.push(json!({
                    "kind": "create",
                    "intent_key": format!("{}:r:{index}:{n}", plan.id),
                    "blueprint_id": rbp.id,
                    "blueprint_version": rbp.version,
                    "values": values,
                }));
                owners.push(index);
            }
        }
        for (chunk_index, chunk) in intents.chunks(100).enumerate() {
            let outcomes = host::apply_batch(
                &format!("{}:remnants:{chunk_index}", plan.id),
                chunk.to_vec(),
            )?;
            if let Some(refusal) = first_error(&outcomes, text::REMNANT_REJECTED) {
                return Ok(refusal);
            }
            for (k, outcome) in outcomes.iter().enumerate() {
                remnant_ids[owners[chunk_index * 100 + k]]
                    .push(outcome.record_id.clone().unwrap_or_default());
            }
        }
    }

    // 3. Material and output lines, 100 intents per batch.
    let output = &production.output;
    let material = &production.material;
    let kind_value = |value: &str| {
        output
            .kind
            .as_ref()
            .map(|k| scalar(&k.attribute, &context, json!(value)))
    };
    let mut intents = Vec::new();
    for (index, (group, lines)) in groups.iter().zip(&computed).enumerate() {
        let order_id = &order_ids[index];
        let output_line = |key: String, item: &str, quantity: Value, kind: Option<&String>| {
            let mut values = vec![
                link(&output.order, &context, order_id),
                link(&output.item, &context, item),
                scalar(&output.quantity, &context, quantity),
            ];
            values.extend(kind.and_then(|k| kind_value(k)));
            json!({"kind": "create", "intent_key": key, "blueprint_id": output_bp.id, "blueprint_version": output_bp.version, "values": values})
        };
        for (n, (stock_index, count, weight)) in lines.materials.iter().enumerate() {
            let quantity = if material.by_weight {
                match weight {
                    Some(weight) => f64::from(*count) * weight,
                    None => return Ok(refused(text::STOCK_WEIGHT_MISSING)),
                }
            } else {
                f64::from(*count)
            };
            intents.push(json!({
                "kind": "create",
                "intent_key": format!("{}:m:{index}:{n}", plan.id),
                "blueprint_id": material_bp.id,
                "blueprint_version": material_bp.version,
                "values": [
                    link(&material.order, &context, order_id),
                    link(&material.item, &context, &group.stock[*stock_index].item_id),
                    scalar(&material.quantity, &context, json!(quantity)),
                ],
            }));
        }
        let product_kind = output.kind.as_ref().map(|k| &k.product);
        for (n, (_line, item, count)) in lines.products.iter().enumerate() {
            intents.push(output_line(
                format!("{}:o:{index}:{n}", plan.id),
                item,
                json!(count),
                product_kind,
            ));
        }
        for (n, remnant_id) in remnant_ids[index].iter().enumerate() {
            intents.push(output_line(
                format!("{}:q:{index}:{n}", plan.id),
                remnant_id,
                json!(1),
                remnant_kind.as_ref(),
            ));
        }
        if let (Some(scrap_id), Some(kg)) = (&scrap_item, lines.scrap_kg) {
            let scrap_kind = output.kind.as_ref().map(|k| &k.scrap);
            intents.push(output_line(
                format!("{}:s:{index}", plan.id),
                scrap_id,
                json!(kg),
                scrap_kind,
            ));
        }
    }
    for (chunk_index, chunk) in intents.chunks(100).enumerate() {
        let outcomes =
            host::apply_batch(&format!("{}:lines:{chunk_index}", plan.id), chunk.to_vec())?;
        if let Some(refusal) = first_error(&outcomes, text::PRODUCTION_LINE_REJECTED) {
            return Ok(refusal);
        }
    }

    let refs: Vec<ProductionRef> = groups
        .iter()
        .enumerate()
        .map(|(i, group)| ProductionRef {
            id: order_ids[i].clone(),
            number: numbers[i].clone(),
            group_key: group.key.clone(),
        })
        .collect();
    let mut value = stored.value;
    value["production_orders"] = serde_json::to_value(&refs).map_err(|e| e.to_string())?;
    host::storage_set(&plans::key(&plan.id), &value, Some(stored.revision))?;
    Ok(Created {
        ok: true,
        message: None,
        production_orders: refs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bars() -> Group {
        serde_json::from_value(json!({
            "key": "k", "label": "RP 40",
            "machine": {"id": "m"},
            "stock": [
                {"item_id": "bar6", "length": 6000.0, "weight": 20.46},
                {"item_id": "bar4", "length": 4000.0, "weight": null}
            ],
            "pieces": [
                {"line_id": "l1", "order_id": "o1", "item_id": "post", "length": 1250.0},
                {"line_id": "l2", "order_id": "o2", "item_id": "rail", "length": 2480.0}
            ],
            "layouts": [
                {"stock": 0, "count": 3, "cuts": [1, 0, 0]},
                {"stock": 0, "count": 1, "cuts": [0, 0, 0, 0], "remnants": [{"length": 1000.0}]}
            ]
        }))
        .unwrap()
    }

    #[test]
    fn sums_bars_pieces_and_scrap() {
        let lines = lines(&bars(), false).unwrap();
        assert_eq!(lines.materials, vec![(0, 4, Some(20.46))]);
        assert_eq!(
            lines.products,
            vec![
                ("l1".into(), "post".into(), 10),
                ("l2".into(), "rail".into(), 3)
            ]
        );
        assert_eq!(lines.orders, vec!["o1".to_owned(), "o2".to_owned()]);
        assert!(lines.remnants.is_empty());
        // 3 × 20.46 × (1 − 4980/6000) + 20.46 × (1 − 5000/6000)
        assert_eq!(lines.scrap_kg, Some(13.845));
    }

    #[test]
    fn booked_remnants_leave_the_scrap() {
        let lines = lines(&bars(), true).unwrap();
        assert_eq!(
            lines.remnants,
            vec![(
                0,
                RemnantRef {
                    length: 1000.0,
                    width: None
                },
                Some(3.41)
            )]
        );
        // 13.845 less the 1000 mm remnant's 3.41 kg
        assert_eq!(lines.scrap_kg, Some(10.435));
    }

    #[test]
    fn sheets_use_areas() {
        let group: Group = serde_json::from_value(json!({
            "key": "s", "label": "S235JR · 3 mm", "machine": null,
            "stock": [{"item_id": "sheet", "length": 3000.0, "width": 1500.0, "weight": 105.975}],
            "pieces": [{"line_id": "l", "order_id": "o", "item_id": "plate", "length": 1000.0, "width": 500.0}],
            "layouts": [{"stock": 0, "count": 2, "placements": [{"piece": 0}, {"piece": 0}],
                         "remnants": [{"length": 1500.0, "width": 1500.0}]}]
        }))
        .unwrap();
        let lines = lines(&group, true).unwrap();
        assert_eq!(lines.products, vec![("l".into(), "plate".into(), 4)]);
        assert_eq!(lines.remnants.len(), 2);
        assert_eq!(lines.remnants[0].2, Some(52.988));
        // 2 × 105.975 × (1 − (1e6 + 2.25e6) / 4.5e6)
        assert_eq!(lines.scrap_kg, Some(58.875));
    }

    #[test]
    fn unknown_weight_leaves_scrap_out() {
        let mut group = bars();
        group.layouts = vec![Layout {
            stock: 1,
            count: 1,
            cuts: vec![0],
            placements: vec![],
            remnants: vec![],
        }];
        assert_eq!(lines(&group, false).unwrap().scrap_kg, None);
    }

    #[test]
    fn rejects_layouts_that_name_unknown_entries() {
        let mut group = bars();
        group.layouts = vec![Layout {
            stock: 5,
            count: 1,
            cuts: vec![0],
            placements: vec![],
            remnants: vec![],
        }];
        assert!(lines(&group, false).is_err());
    }
}
