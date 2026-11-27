//! Cutting plans in the extension's storage, one key per plan. The frame
//! computes a plan and saves it whole; the server reads only the parts it
//! needs to list plans and to create production orders.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::host;
use crate::text;

pub const PREFIX: &str = "plan:";
/// Storage values are limited to 64 KiB of JSON.
const MAX_PLAN_BYTES: usize = 60 * 1024;

pub fn key(plan_id: &str) -> String {
    format!("{PREFIX}{plan_id}")
}

/// Plan IDs come from the frame; keep them short and plain so they fit
/// storage keys, intent keys and production order numbers.
pub fn valid_id(plan_id: &str) -> bool {
    (8..=40).contains(&plan_id.len())
        && plan_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[derive(Deserialize, Serialize, Clone)]
pub struct OrderRef {
    pub id: String,
    pub number: String,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct ProductionRef {
    pub id: String,
    pub number: String,
    pub group_key: String,
}

/// The fields of a stored plan the server uses; the rest is kept as is.
#[derive(Deserialize)]
pub struct PlanHead {
    pub id: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub orders: Vec<OrderRef>,
    #[serde(default)]
    pub production_orders: Vec<ProductionRef>,
    #[serde(default)]
    pub groups: Vec<GroupHead>,
}

#[derive(Deserialize)]
pub struct GroupHead {
    pub label: String,
}

#[derive(Serialize)]
pub struct Saved {
    ok: bool,
    message: Option<String>,
}

pub fn save(plan: Value) -> Result<Saved, String> {
    let head: PlanHead =
        serde_json::from_value(plan.clone()).map_err(|e| format!("invalid plan: {e}"))?;
    if !valid_id(&head.id) {
        return Ok(Saved {
            ok: false,
            message: Some(text::INVALID_PLAN_ID.into()),
        });
    }
    if plan.to_string().len() > MAX_PLAN_BYTES {
        return Ok(Saved {
            ok: false,
            message: Some(text::PLAN_TOO_LARGE.into()),
        });
    }
    let existing = host::storage_get(&key(&head.id))?;
    if let Some(stored) = &existing {
        let stored_head: PlanHead = serde_json::from_value(stored.value.clone())
            .map_err(|e| format!("stored plan: {e}"))?;
        if !stored_head.production_orders.is_empty() {
            return Ok(Saved {
                ok: false,
                message: Some(text::PLAN_ALREADY_ORDERED.into()),
            });
        }
    }
    let mut plan = plan;
    plan["production_orders"] = json!([]);
    host::storage_set(&key(&head.id), &plan, existing.map(|s| s.revision))?;
    Ok(Saved {
        ok: true,
        message: None,
    })
}

pub fn get(plan_id: &str) -> Result<Value, String> {
    if !valid_id(plan_id) {
        return Ok(json!({"plan": null}));
    }
    Ok(json!({"plan": host::storage_get(&key(plan_id))?.map(|stored| stored.value)}))
}

#[derive(Serialize)]
pub struct Summary {
    id: String,
    created_at: Option<String>,
    orders: Vec<OrderRef>,
    production_orders: Vec<ProductionRef>,
    groups: Vec<String>,
}

/// Plans newest first, only those that include `record_id` (as a customer
/// order or a production order) when it is given.
pub fn list(record_id: Option<&str>) -> Result<Value, String> {
    let mut summaries: Vec<Summary> = host::storage_list(PREFIX, 500)?
        .into_iter()
        .filter_map(|value| serde_json::from_value::<PlanHead>(value).ok())
        .filter(|plan| match record_id {
            Some(id) => {
                plan.orders.iter().any(|o| o.id == id)
                    || plan.production_orders.iter().any(|p| p.id == id)
            }
            None => true,
        })
        .map(|plan| Summary {
            id: plan.id,
            created_at: plan.created_at,
            orders: plan.orders,
            production_orders: plan.production_orders,
            groups: plan.groups.into_iter().map(|g| g.label).collect(),
        })
        .collect();
    summaries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    summaries.truncate(100);
    Ok(json!({"plans": summaries}))
}
