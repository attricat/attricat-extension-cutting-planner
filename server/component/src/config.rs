//! The installation configuration: which blueprints and attributes play which
//! part in planning. Nothing here is tied to one solution pack; a pack that
//! installs the extension supplies its own codes, and every attribute code
//! has a default so a configuration names only what differs.

use serde::Deserialize;

macro_rules! default_fn {
    ($name:ident, $value:expr) => {
        fn $name() -> String {
            $value.into()
        }
    };
}

default_fn!(number, "number");
default_fn!(customer, "customer");
default_fn!(status, "status");
default_fn!(due_date, "due_date");
default_fn!(customer_order, "customer_order");
default_fn!(item, "item");
default_fn!(quantity, "quantity");
default_fn!(length_mm, "length_mm");
default_fn!(width_mm, "width_mm");
default_fn!(thickness_mm, "thickness_mm");
default_fn!(name, "name");
default_fn!(process, "process");
default_fn!(kerf_mm, "kerf_mm");
default_fn!(part_spacing_mm, "part_spacing_mm");
default_fn!(edge_trim_mm, "edge_trim_mm");
default_fn!(min_thickness_mm, "min_thickness_mm");
default_fn!(max_thickness_mm, "max_thickness_mm");
default_fn!(max_width_mm, "max_width_mm");
default_fn!(max_length_mm, "max_length_mm");
default_fn!(guillotine_only, "guillotine_only");
default_fn!(production_order, "production_order");
default_fn!(machine, "machine");
default_fn!(kind, "kind");
default_fn!(draft, "draft");
default_fn!(default_context, "default");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// The context values are read and written in, by code.
    #[serde(default = "default_context")]
    pub context: String,
    pub orders: Orders,
    pub order_lines: OrderLines,
    /// Pieces cut across bars and profiles on a saw.
    pub bars: Option<Bars>,
    /// Rectangular parts cut from sheets on a guillotine, laser or plasma.
    pub sheets: Option<Sheets>,
    /// Usable remnants as stock records of their own (stage 3).
    pub remnants: Option<Remnants>,
    pub stock_levels: StockLevels,
    pub machines: Machines,
    pub production: Production,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Orders {
    pub blueprint: String,
    #[serde(default = "number")]
    pub number: String,
    #[serde(default = "customer")]
    pub customer: String,
    #[serde(default = "status")]
    pub status: String,
    /// Statuses of orders the planner offers; empty offers every order.
    #[serde(default)]
    pub open_statuses: Vec<String>,
    #[serde(default = "due_date")]
    pub due_date: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OrderLines {
    pub blueprint: String,
    /// The line's relationship to its order.
    #[serde(default = "customer_order")]
    pub order: String,
    #[serde(default = "item")]
    pub item: String,
    /// Pieces ordered.
    #[serde(default = "quantity")]
    pub quantity: String,
}

/// An item blueprint whose pieces are cut, and where its dimensions are.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PieceSource {
    pub blueprint: String,
    /// A relationship from the item to the record that carries the
    /// dimensions, such as a product's specification; absent when the item
    /// carries them itself.
    pub via: Option<String>,
}

/// Bars and profiles: what a piece and a stock bar are, and the attributes
/// that say which bars a piece can be cut from.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bars {
    pub pieces: Vec<PieceSource>,
    /// Blueprints of the bars held in stock.
    pub stock: Vec<String>,
    /// Length in millimetres, on the piece's specification and on the bar.
    #[serde(default = "length_mm")]
    pub length: String,
    /// Attributes that must match between a piece's specification and a bar,
    /// such as the section and the grade. A relationship matches by target.
    pub section: Vec<String>,
    /// Weight of one bar in kilograms.
    pub weight: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sheets {
    pub pieces: Vec<PieceSource>,
    /// Blueprints of the sheets held in stock.
    pub stock: Vec<String>,
    #[serde(default = "length_mm")]
    pub length: String,
    #[serde(default = "width_mm")]
    pub width: String,
    #[serde(default = "thickness_mm")]
    pub thickness: String,
    /// Attributes that must match between a part and a sheet, such as the
    /// grade and the thickness.
    #[serde(rename = "match")]
    pub matches: Vec<String>,
    /// Weight of one sheet in kilograms; without it, computed from the
    /// dimensions and `density`.
    pub weight: Option<String>,
    pub density: Option<Density>,
    /// A boolean on the part: may it be turned 90°. Absent means yes.
    pub rotate: Option<String>,
    /// A boolean on the part: is it shaped (holes, curves), for the CAM.
    pub shaped: Option<String>,
}

/// kg/dm³ on a related record, such as the grade's density.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Density {
    pub via: String,
    pub attribute: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Remnants {
    pub blueprint: String,
    #[serde(default = "name")]
    pub name: String,
    /// Relationship to the bar or sheet the remnant was cut from.
    pub source: Option<String>,
    #[serde(default = "length_mm")]
    pub length: String,
    #[serde(default = "width_mm")]
    pub width: String,
    pub weight: Option<String>,
    /// Attributes copied from the bar or sheet, so the remnant matches the
    /// same pieces: the section or match attributes, such as grade and
    /// thickness.
    #[serde(default)]
    pub copy: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StockLevels {
    pub blueprint: String,
    #[serde(default = "item")]
    pub item: String,
    #[serde(default = "quantity")]
    pub quantity: String,
    /// A balance already promised elsewhere, subtracted from the quantity.
    pub reserved: Option<String>,
    /// When stock is kept in another unit (such as kilograms), the bar's or
    /// sheet's attribute that one piece is worth in it (such as its weight).
    pub per_piece: Option<String>,
}

/// The values of a machine's process attribute that mean each kind.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Processes {
    #[serde(default = "saw")]
    pub saw: Vec<String>,
    #[serde(default = "guillotine")]
    pub guillotine: Vec<String>,
    #[serde(default = "laser")]
    pub laser: Vec<String>,
    #[serde(default = "plasma")]
    pub plasma: Vec<String>,
}

fn saw() -> Vec<String> {
    vec!["saw".into()]
}
fn guillotine() -> Vec<String> {
    vec!["guillotine".into()]
}
fn laser() -> Vec<String> {
    vec!["laser".into()]
}
fn plasma() -> Vec<String> {
    vec!["plasma".into()]
}

impl Default for Processes {
    fn default() -> Self {
        Self {
            saw: saw(),
            guillotine: guillotine(),
            laser: laser(),
            plasma: plasma(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Machines {
    pub blueprint: String,
    #[serde(default = "name")]
    pub name: String,
    #[serde(default = "process")]
    pub process: String,
    #[serde(default)]
    pub processes: Processes,
    #[serde(default = "kerf_mm")]
    pub kerf: String,
    #[serde(default = "part_spacing_mm")]
    pub spacing: String,
    #[serde(default = "edge_trim_mm")]
    pub edge_trim: String,
    #[serde(default = "guillotine_only")]
    pub guillotine_only: String,
    #[serde(default = "min_thickness_mm")]
    pub min_thickness: String,
    #[serde(default = "max_thickness_mm")]
    pub max_thickness: String,
    #[serde(default = "max_width_mm")]
    pub max_width: String,
    #[serde(default = "max_length_mm")]
    pub max_length: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Production {
    pub order: ProductionOrder,
    pub material: MaterialLine,
    pub output: OutputLine,
    /// The item scrap is booked to; without it no scrap line is written.
    pub scrap_item: Option<ScrapItem>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProductionOrder {
    pub blueprint: String,
    #[serde(default = "number")]
    pub number: String,
    #[serde(default = "status")]
    pub status: String,
    /// Written with the order, unless the status has a workflow that sets
    /// its own first status (then leave this out).
    pub initial_status: Option<String>,
    /// Relationship to the customer orders the production order serves.
    pub customer_orders: Option<String>,
    #[serde(default = "machine")]
    pub machine: String,
    /// String attribute that records the plan ID.
    pub plan: Option<String>,
}

impl ProductionOrder {
    pub fn initial_status(&self) -> Option<String> {
        self.initial_status
            .clone()
            .or_else(|| Some(draft()))
            .filter(|s| !s.is_empty())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MaterialLine {
    pub blueprint: String,
    #[serde(default = "production_order")]
    pub order: String,
    #[serde(default = "item")]
    pub item: String,
    #[serde(default = "quantity")]
    pub quantity: String,
    /// When the line is in another unit than pieces (such as kilograms):
    /// the bar's or sheet's weight is written instead of the count.
    #[serde(default)]
    pub by_weight: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputLine {
    pub blueprint: String,
    #[serde(default = "production_order")]
    pub order: String,
    #[serde(default = "item")]
    pub item: String,
    #[serde(default = "quantity")]
    pub quantity: String,
    pub kind: Option<OutputKinds>,
}

/// The output line's kind attribute and its values.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OutputKinds {
    #[serde(default = "kind")]
    pub attribute: String,
    pub product: String,
    pub scrap: String,
    pub remnant: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ScrapItem {
    pub blueprint: String,
    /// A unique attribute of the scrap item and its value, such as its code.
    pub attribute: String,
    pub value: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_minimal_configuration_takes_defaults() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "orders": {"blueprint": "order"},
            "order_lines": {"blueprint": "order_line"},
            "bars": {"pieces": [{"blueprint": "product", "via": "spec"}], "stock": ["profile"], "section": ["section", "grade"]},
            "sheets": {"pieces": [{"blueprint": "plate"}], "stock": ["sheet"], "match": ["grade", "thickness_mm"]},
            "stock_levels": {"blueprint": "stock_item"},
            "machines": {"blueprint": "machine"},
            "production": {
                "order": {"blueprint": "production_order"},
                "material": {"blueprint": "production_material"},
                "output": {"blueprint": "production_output"}
            }
        }))
        .unwrap();
        assert_eq!(config.context, "default");
        assert_eq!(config.order_lines.order, "customer_order");
        assert_eq!(config.machines.processes.saw, vec!["saw"]);
        assert_eq!(config.sheets.unwrap().thickness, "thickness_mm");
        assert_eq!(
            config.production.order.initial_status().as_deref(),
            Some("draft")
        );
    }

    #[test]
    fn an_empty_initial_status_writes_none() {
        let order: ProductionOrder =
            serde_json::from_value(serde_json::json!({"blueprint": "po", "initial_status": ""}))
                .unwrap();
        assert_eq!(order.initial_status(), None);
    }

    #[test]
    fn unknown_fields_are_refused() {
        let result: Result<Orders, _> =
            serde_json::from_value(serde_json::json!({"blueprint": "o", "nmber": "x"}));
        assert!(result.is_err());
    }
}
