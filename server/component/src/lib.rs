//! Cutting planner: plans cutting bars from stock and turns a plan into
//! production orders.
//!
//! One component on the `attricat:host@1.2.0` ABI (`outcome-extension`
//! world). `command-handler` serves the frames: loading orders, pieces and
//! stock, saving and checking plans, creating production orders.
//! `deferrable-operations` renders the cutting sheet PDF ([`sheet`]).
//! The solver runs in the browser; see `solver/`.

#![cfg_attr(test, allow(dead_code))]

wit_bindgen::generate!({
    path: "wit",
    world: "outcome-extension",
});

mod check;
mod config;
mod demand;
mod host;
mod plans;
mod production;
mod sheet;
mod stock;
mod text;
mod values;

use serde::Deserialize;
use serde_json::{Value, json};

use attricat::host::api::Event;
use attricat::host::outcomes::{Failure, Retry};
use exports::attricat::host::{
    command_handler::{CommandRequest, CommandResponse},
    deferrable_operations::{BatchOutcome, OperationRequest},
    event_handler::Delivery,
};

impl From<String> for Failure {
    fn from(message: String) -> Self {
        Failure::Retry(Retry {
            message,
            after_ms: None,
        })
    }
}

fn parse<T: for<'de> Deserialize<'de>>(payload: &str) -> Result<T, String> {
    host::decode(payload, "request")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlanId {
    plan_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ListPlans {
    record_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SavePlan {
    plan: Value,
}

fn to_value<T: serde::Serialize>(value: Result<T, String>) -> Result<Value, String> {
    value.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

fn handle(handler: &str, payload: &str) -> Result<Value, String> {
    // Storage-only commands work even before the extension is configured.
    match handler {
        "save-plan" => return to_value(plans::save(parse::<SavePlan>(payload)?.plan)),
        "get-plan" => return plans::get(&parse::<PlanId>(payload)?.plan_id),
        "list-plans" => return plans::list(parse::<ListPlans>(payload)?.record_id.as_deref()),
        _ => {}
    }
    let config = match host::configuration() {
        Ok(config) => config,
        Err(error) => {
            return Ok(
                json!({"ok": false, "message": format!("{} {error}", text::CONFIGURATION_INVALID)}),
            );
        }
    };
    let mut reader = host::Reader::new(&config.context)?;
    match handler {
        "list-orders" => to_value(demand::list_orders(&config, &mut reader)),
        "load-demand" => to_value(demand::load_demand(&config, &mut reader, parse(payload)?)),
        "load-stock" => to_value(stock::load_stock(&config, &mut reader, parse(payload)?)),
        "check-plan" => to_value(check::check(&config, &mut reader, parse(payload)?)),
        "create-production-orders" => {
            to_value(production::create(&config, &mut reader, parse(payload)?))
        }
        other => Err(format!("unknown command handler '{other}'")),
    }
}

struct Extension;

impl exports::attricat::host::command_handler::Guest for Extension {
    fn handle_command(request: CommandRequest) -> Result<CommandResponse, String> {
        // A failure the user can act on reaches the frame as a refusal with
        // its reason; the host would replace a returned error with a generic one.
        let value = handle(&request.handler, &request.payload).unwrap_or_else(|error| {
            host::log("error", &format!("{}: {error}", request.handler));
            json!({"ok": false, "message": format!("{} ({error})", text::COMMAND_FAILED)})
        });
        Ok(CommandResponse {
            payload: host::encode(&value)?,
        })
    }
}

impl exports::attricat::host::event_handler::Guest for Extension {
    fn handle_event(_event: Event, _delivery: Delivery) -> Result<(), Failure> {
        Ok(())
    }
}

/// One operation: the cutting sheet PDF for a production order.
impl exports::attricat::host::deferrable_operations::Guest for Extension {
    fn prepare(request: OperationRequest) -> Result<String, String> {
        match request.operation_id.as_str() {
            sheet::OPERATION => sheet::prepare(&request),
            other => Err(format!("unknown operation {other}")),
        }
    }
    fn start(_request: OperationRequest) -> Result<String, String> {
        Ok("started".into())
    }
    fn process_batch(request: OperationRequest) -> Result<BatchOutcome, Failure> {
        match request.operation_id.as_str() {
            sheet::OPERATION => sheet::process_batch(&request),
            other => Err(Failure::Fault(format!("unknown operation {other}"))),
        }
    }
    fn checkpoint(_request: OperationRequest) -> Result<(), String> {
        Ok(())
    }
    fn finish(_request: OperationRequest) -> Result<(), String> {
        Ok(())
    }
    fn cancel(_request: OperationRequest) -> Result<(), String> {
        Ok(())
    }
}

export!(Extension);
