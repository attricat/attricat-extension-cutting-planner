//! A record's values as an extension reads them.
//!
//! Scalars come resolved by the host in a context: keyed by attribute code,
//! each `{value, source_context}`. Relationships do not: an extension's
//! resolved read expands no relationship (its items are empty and
//! `truncated`), so targets come from the record's direct values, which
//! name the attribute by ID and the target by `relationship_target_record_id`.

use std::collections::HashMap;

use serde_json::Value;

pub struct Values {
    resolved: Value,
    /// Target record IDs per relationship attribute code.
    relations: HashMap<String, Vec<String>>,
}

impl Values {
    /// `attributes` is the blueprint revision's attribute list (for codes);
    /// relationship values in `context_id` win over those in other contexts.
    pub fn new(resolved: Value, direct: &[Value], attributes: &[Value], context_id: &str) -> Self {
        let codes: HashMap<&str, &str> = attributes
            .iter()
            .filter_map(|a| Some((a.get("id")?.as_str()?, a.get("code")?.as_str()?)))
            .collect();
        let mut in_context: HashMap<String, Vec<String>> = HashMap::new();
        let mut elsewhere: HashMap<String, Vec<String>> = HashMap::new();
        for value in direct {
            if value.get("active").and_then(Value::as_bool) == Some(false) {
                continue;
            }
            let Some(target) = value
                .get("relationship_target_record_id")
                .and_then(Value::as_str)
            else {
                continue;
            };
            let Some(code) = value
                .get("attribute_id")
                .and_then(Value::as_str)
                .and_then(|id| codes.get(id))
            else {
                continue;
            };
            let bucket = if value.get("context_id").and_then(Value::as_str) == Some(context_id) {
                &mut in_context
            } else {
                &mut elsewhere
            };
            bucket
                .entry((*code).to_owned())
                .or_default()
                .push(target.to_owned());
        }
        for (code, targets) in elsewhere {
            in_context.entry(code).or_insert(targets);
        }
        Self {
            resolved,
            relations: in_context,
        }
    }

    fn raw(&self, code: &str) -> Option<&Value> {
        self.resolved
            .get(code)?
            .get("value")
            .filter(|v| !v.is_null())
    }

    pub fn number(&self, code: &str) -> Option<f64> {
        match self.raw(code)? {
            Value::Number(number) => number.as_f64(),
            Value::String(text) => text.trim().replace(',', ".").parse().ok(),
            _ => None,
        }
    }

    pub fn text(&self, code: &str) -> Option<String> {
        match self.raw(code)? {
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        }
    }

    pub fn boolean(&self, code: &str) -> Option<bool> {
        match self.raw(code)? {
            Value::Bool(flag) => Some(*flag),
            Value::String(text) => match text.as_str() {
                "true" => Some(true),
                "false" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }

    /// A scalar value as stored, for copying it to another record.
    pub fn scalar(&self, code: &str) -> Option<Value> {
        self.raw(code).filter(|v| !v.is_object()).cloned()
    }

    pub fn targets(&self, code: &str) -> &[String] {
        self.relations
            .get(code)
            .map(Vec::as_slice)
            .unwrap_or_default()
    }

    pub fn target(&self, code: &str) -> Option<&str> {
        self.targets(code).first().map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Values {
        let context = json!({"id": "c", "code": "default"});
        Values::new(
            json!({
                "quantity": {"value": 30, "source_context": context},
                "length": {"value": "1250,5", "source_context": context},
                "section": {"value": "RP 40×40×3", "source_context": context},
                "grade": {"value": {"items": [], "truncated": true}, "source_context": context},
                "empty": {"value": null, "source_context": context},
            }),
            &[
                json!({"attribute_id": "a-grade", "relationship_target_record_id": "g-other", "context_id": "other", "active": true}),
                json!({"attribute_id": "a-grade", "relationship_target_record_id": "g1", "context_id": "c", "active": true}),
                json!({"attribute_id": "a-tags", "relationship_target_record_id": "t1", "context_id": "other", "active": true}),
                json!({"attribute_id": "a-tags", "relationship_target_record_id": "t2", "context_id": "other", "active": false}),
                json!({"attribute_id": "a-quantity", "relationship_target_record_id": null, "context_id": "c", "value": 30}),
            ],
            &[
                json!({"id": "a-grade", "code": "grade"}),
                json!({"id": "a-tags", "code": "tags"}),
                json!({"id": "a-quantity", "code": "quantity"}),
            ],
            "c",
        )
    }

    #[test]
    fn reads_numbers_and_text() {
        let values = sample();
        assert_eq!(values.number("quantity"), Some(30.0));
        assert_eq!(values.number("length"), Some(1250.5));
        assert_eq!(values.text("section").as_deref(), Some("RP 40×40×3"));
        assert_eq!(values.number("empty"), None);
        assert_eq!(values.number("missing"), None);
    }

    #[test]
    fn relationships_come_from_direct_values_preferring_the_context() {
        let values = sample();
        assert_eq!(values.target("grade"), Some("g1"));
        assert_eq!(values.targets("tags"), ["t1".to_owned()]);
        assert!(values.targets("quantity").is_empty());
    }
}
