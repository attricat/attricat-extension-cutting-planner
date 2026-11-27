//! The cutting sheet (karta cięcia): an A4 PDF per production order with the
//! order, machine and material, each layout's drawing and count with a box to
//! tick, the piece list, the cut order for guillotine plans, and fields to
//! sign. Drawn in grayscale so it prints legibly.
//!
//! It is an interactive operation started from the production order's
//! dialog. The PDF is rendered from the saved plan (deterministically, so a
//! retried batch appends identical bytes) and appended 64 KiB per batch.

pub mod pdf;
pub mod ttf;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::attricat::host::outcomes::{Failure, Rejection};
use crate::attricat::host::{artifacts, selection};
use crate::exports::attricat::host::deferrable_operations::{BatchOutcome, OperationRequest};
use crate::host;
use crate::plans;
use crate::text;
use pdf::{Document, Face, Fonts, PAGE_HEIGHT, PAGE_WIDTH, Stroke};

pub const OPERATION: &str = "cutting-sheet";
const CHUNK: usize = 64 * 1024;
const MARGIN: f64 = 36.0;
const BOTTOM: f64 = PAGE_HEIGHT - 52.0;

#[derive(Deserialize)]
pub struct Plan {
    pub id: String,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub orders: Vec<OrderRef>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub production_orders: Vec<ProductionRef>,
}

#[derive(Deserialize)]
pub struct OrderRef {
    pub number: String,
}

#[derive(Deserialize)]
pub struct ProductionRef {
    pub id: String,
    pub number: String,
    pub group_key: String,
}

#[derive(Deserialize)]
pub struct Group {
    pub key: String,
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub machine: Option<MachineRef>,
    pub settings: Settings,
    pub stock: Vec<Stock>,
    pub pieces: Vec<Piece>,
    pub layouts: Vec<Layout>,
    #[serde(default)]
    pub figures: Option<Figures>,
}

#[derive(Deserialize)]
pub struct MachineRef {
    pub name: String,
    #[serde(default)]
    pub process: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default)]
    pub kerf: f64,
    #[serde(default)]
    pub start_trim: f64,
    #[serde(default)]
    pub spacing: f64,
    #[serde(default)]
    pub min_remnant: f64,
}

#[derive(Deserialize)]
pub struct Stock {
    pub label: String,
    pub length: f64,
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub remnant: bool,
}

#[derive(Deserialize)]
pub struct Piece {
    pub item_label: String,
    pub length: f64,
    #[serde(default)]
    pub width: Option<f64>,
    pub order_number: String,
    #[serde(default)]
    pub customer: Option<String>,
}

#[derive(Deserialize, Clone, Copy)]
pub struct RemnantRect {
    #[serde(default)]
    pub x: Option<f64>,
    #[serde(default)]
    pub y: Option<f64>,
    pub length: f64,
    #[serde(default)]
    pub width: Option<f64>,
}

#[derive(Deserialize)]
pub struct PlacementRef {
    pub piece: usize,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub rotated: bool,
}

#[derive(Deserialize)]
pub struct Layout {
    pub stock: usize,
    pub count: u32,
    #[serde(default)]
    pub cuts: Vec<usize>,
    #[serde(default)]
    pub trim: f64,
    #[serde(default)]
    pub offcut: f64,
    #[serde(default)]
    pub offcut_kind: Option<String>,
    #[serde(default)]
    pub placements: Vec<PlacementRef>,
    #[serde(default)]
    pub cut_lines: Vec<[f64; 6]>,
    #[serde(default)]
    pub remnants: Vec<RemnantRect>,
    #[serde(default)]
    pub edge_trim: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Figures {
    #[serde(default)]
    pub pieces: u32,
    #[serde(default)]
    pub stock_measure: f64,
    #[serde(default)]
    pub parts_measure: f64,
    #[serde(default)]
    pub stock_kg: Option<f64>,
    #[serde(default)]
    pub parts_kg: Option<f64>,
}

fn mm(value: f64) -> String {
    let rounded = (value * 10.0).round() / 10.0;
    let text = if rounded.fract() == 0.0 {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}").replace('.', ",")
    };
    // Thousands with a thin space, as Polish typesetting does.
    let (int, frac) = text
        .split_once(',')
        .map_or((text.as_str(), None), |(i, f)| (i, Some(f)));
    let digits: Vec<char> = int.chars().collect();
    let mut grouped = String::new();
    for (i, c) in digits.iter().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 && digits.len() > 4 {
            grouped.push('\u{2009}');
        }
        grouped.push(*c);
    }
    match frac {
        Some(f) => format!("{grouped},{f}"),
        None => grouped,
    }
}

fn kg(value: f64) -> String {
    format!("{} kg", format!("{:.1}", value).replace('.', ","))
}

fn size(length: f64, width: Option<f64>) -> String {
    match width {
        Some(width) => format!("{} × {}", mm(length), mm(width)),
        None => mm(length),
    }
}

struct Writer<'f> {
    doc: Document<'f>,
    page: usize,
    y: f64,
    header: String,
}

impl<'f> Writer<'f> {
    fn new(fonts: &'f Fonts, header: String) -> Self {
        let mut doc = Document::new(fonts);
        let page = doc.add_page();
        Self {
            doc,
            page,
            y: MARGIN,
            header,
        }
    }

    /// Starts a new page when `height` does not fit on this one.
    fn room(&mut self, height: f64) {
        if self.y + height > BOTTOM {
            self.page = self.doc.add_page();
            self.y = MARGIN;
            self.doc.text(
                self.page,
                Face::Sans,
                8.0,
                MARGIN,
                self.y + 8.0,
                &self.header.clone(),
                0.35,
            );
            self.y += 22.0;
        }
    }
}

const CONTENT: f64 = PAGE_WIDTH - 2.0 * MARGIN;

/// The PDF for one production order's group.
pub fn render(plan: &Plan, group: &Group, number: &str) -> Result<Vec<u8>, String> {
    let fonts = Fonts::load()?;
    let mut w = Writer::new(
        &fonts,
        format!("{} · {number} · {}", text::SHEET_TITLE, group.label),
    );
    let sheet = group.kind == "sheet";
    let guillotine = sheet && group.mode.as_deref() == Some("guillotine");

    w.doc.text(
        w.page,
        Face::Bold,
        20.0,
        MARGIN,
        w.y + 18.0,
        text::SHEET_TITLE,
        0.0,
    );
    w.doc.text_right(
        w.page,
        Face::Mono,
        11.0,
        MARGIN + CONTENT,
        w.y + 16.0,
        number,
        0.0,
    );
    w.y += 34.0;

    let machine = group.machine.as_ref().map(|m| match &m.process {
        Some(process) => format!("{} · {}", m.name, text::process(process)),
        None => m.name.clone(),
    });
    let mut settings = vec![format!(
        "{} {} mm",
        text::SHEET_KERF,
        mm(group.settings.kerf)
    )];
    settings.push(format!(
        "{} {} mm",
        if sheet {
            text::SHEET_EDGE_TRIM
        } else {
            text::SHEET_START_TRIM
        },
        mm(group.settings.start_trim)
    ));
    if sheet && !guillotine {
        settings.push(format!(
            "{} {} mm",
            text::SHEET_SPACING,
            mm(group.settings.spacing)
        ));
    }
    if group.settings.min_remnant > 0.0 {
        settings.push(format!(
            "{} {} mm",
            text::SHEET_MIN_REMNANT,
            mm(group.settings.min_remnant)
        ));
    }
    let usage = group.figures.as_ref().map(|f| {
        let count = if sheet {
            text::sheets(f.pieces)
        } else {
            text::bars(f.pieces)
        };
        let share = match (f.parts_kg, f.stock_kg) {
            (Some(parts), Some(stock)) if stock > 0.0 => parts / stock,
            _ if f.stock_measure > 0.0 => f.parts_measure / f.stock_measure,
            _ => 0.0,
        };
        let weight = f
            .stock_kg
            .map(|k| format!(" · {}", kg(k)))
            .unwrap_or_default();
        format!(
            "{count}{weight} · {} {}",
            text::SHEET_UTILISATION,
            format!("{:.1} %", share * 100.0).replace('.', ",")
        )
    });
    let date = plan
        .created_at
        .as_deref()
        .map(|d| d.chars().take(10).collect::<String>());
    let rows: Vec<(&str, String)> = vec![
        (text::SHEET_MACHINE, machine.unwrap_or_else(|| "—".into())),
        (text::SHEET_MATERIAL, group.label.clone()),
        (text::SHEET_ORDERS, {
            let mut numbers: Vec<&str> = group
                .pieces
                .iter()
                .map(|p| p.order_number.as_str())
                .collect();
            numbers.sort();
            numbers.dedup();
            numbers.join(", ")
        }),
        (
            text::SHEET_PLAN,
            format!(
                "{}{}",
                plan.id,
                date.map(|d| format!(" · {d}")).unwrap_or_default()
            ),
        ),
        (text::SHEET_SETTINGS, settings.join(" · ")),
        (text::SHEET_USAGE, usage.unwrap_or_else(|| "—".into())),
    ];
    for (label, value) in rows {
        w.doc
            .text(w.page, Face::Sans, 9.0, MARGIN, w.y + 9.0, label, 0.35);
        w.doc.text_fit(
            w.page,
            Face::Sans,
            9.5,
            MARGIN + 110.0,
            w.y + 9.0,
            &value,
            CONTENT - 110.0,
            0.0,
        );
        w.y += 15.0;
    }
    w.y += 6.0;
    w.doc.line(
        w.page,
        MARGIN,
        w.y,
        MARGIN + CONTENT,
        w.y,
        Stroke::solid(0.6, 0.6),
    );
    w.y += 14.0;

    for (index, layout) in group.layouts.iter().enumerate() {
        let Some(stock) = group.stock.get(layout.stock) else {
            continue;
        };
        let (draw_w, draw_h) = if sheet {
            let width = stock.width.unwrap_or(1.0);
            let scale = (CONTENT / stock.length).min(250.0 / width);
            (stock.length * scale, width * scale)
        } else {
            (CONTENT, 28.0)
        };
        w.room(draw_h + 40.0);
        let heading = format!(
            "{} {} · ×{} · {} · {} mm{}",
            text::SHEET_LAYOUT,
            index + 1,
            layout.count,
            stock.label,
            size(stock.length, stock.width),
            if stock.remnant {
                format!(" · {}", text::REMNANT.to_lowercase())
            } else {
                String::new()
            }
        );
        w.doc.text_fit(
            w.page,
            Face::Bold,
            9.5,
            MARGIN,
            w.y + 9.0,
            &heading,
            CONTENT - 90.0,
            0.0,
        );
        // A box to tick for each repeat (up to ten), else one box.
        let boxes = layout.count.min(10) as usize;
        let mut bx = MARGIN + CONTENT - 9.0;
        for _ in 0..boxes {
            w.doc.rect(
                w.page,
                bx,
                w.y,
                9.0,
                9.0,
                None,
                Some(Stroke::solid(0.7, 0.0)),
            );
            bx -= 12.0;
        }
        w.y += 16.0;
        if sheet {
            draw_sheet(
                &mut w.doc,
                w.page,
                MARGIN,
                w.y,
                draw_w / stock.length,
                stock,
                layout,
                group,
                guillotine,
            );
        } else {
            draw_bar(
                &mut w.doc, w.page, MARGIN, w.y, draw_w, draw_h, stock, layout, group,
            );
        }
        w.y += draw_h + 18.0;
    }

    // Legend.
    w.room(30.0);
    let legend_y = w.y;
    w.doc.rect(
        w.page,
        MARGIN,
        legend_y,
        16.0,
        9.0,
        Some(1.0),
        Some(Stroke::solid(0.6, 0.0)),
    );
    w.doc.text(
        w.page,
        Face::Sans,
        8.0,
        MARGIN + 20.0,
        legend_y + 8.0,
        text::SHEET_LEGEND_PIECE,
        0.2,
    );
    w.doc.rect(
        w.page,
        MARGIN + 70.0,
        legend_y,
        16.0,
        9.0,
        Some(0.97),
        Some(Stroke::dashed(0.6, 0.2, 2.0, 1.5)),
    );
    w.doc.text(
        w.page,
        Face::Sans,
        8.0,
        MARGIN + 90.0,
        legend_y + 8.0,
        text::REMNANT,
        0.2,
    );
    w.doc.hatch(
        w.page,
        MARGIN + 160.0,
        legend_y,
        16.0,
        9.0,
        3.0,
        Stroke::solid(0.4, 0.45),
    );
    w.doc.text(
        w.page,
        Face::Sans,
        8.0,
        MARGIN + 180.0,
        legend_y + 8.0,
        text::SHEET_LEGEND_SCRAP,
        0.2,
    );
    w.y += 16.0;
    if guillotine {
        w.room(14.0);
        w.doc.text_fit(
            w.page,
            Face::Sans,
            8.0,
            MARGIN,
            w.y + 8.0,
            text::SHEET_CUT_ORDER,
            CONTENT,
            0.2,
        );
        w.y += 14.0;
    }
    w.y += 10.0;

    // Piece list.
    let placed = placed_counts(group);
    let columns: [(f64, &str, bool); 6] = [
        (24.0, text::SHEET_COL_NO, true),
        (186.0, text::SHEET_COL_ITEM, false),
        (92.0, text::SHEET_COL_SIZE, true),
        (40.0, text::SHEET_COL_QUANTITY, true),
        (78.0, text::SHEET_COL_ORDER, false),
        (
            CONTENT - 24.0 - 186.0 - 92.0 - 40.0 - 78.0,
            text::SHEET_COL_CUSTOMER,
            false,
        ),
    ];
    let header_row = |w: &mut Writer| {
        let mut x = MARGIN;
        w.doc
            .rect(w.page, MARGIN, w.y, CONTENT, 16.0, Some(0.93), None);
        for (width, title, right) in columns {
            if right {
                w.doc.text_right(
                    w.page,
                    Face::Bold,
                    8.0,
                    x + width - 4.0,
                    w.y + 11.0,
                    title,
                    0.2,
                );
            } else {
                w.doc
                    .text(w.page, Face::Bold, 8.0, x + 4.0, w.y + 11.0, title, 0.2);
            }
            x += width;
        }
        w.y += 16.0;
    };
    w.room(40.0);
    w.doc.text(
        w.page,
        Face::Bold,
        11.0,
        MARGIN,
        w.y + 10.0,
        text::SHEET_PIECES,
        0.0,
    );
    w.y += 18.0;
    header_row(&mut w);
    for (index, piece) in group.pieces.iter().enumerate() {
        let before = w.page;
        w.room(15.0);
        if w.page != before {
            header_row(&mut w);
        }
        let cells = [
            (format!("{}", index + 1), Face::Mono),
            (piece.item_label.clone(), Face::Sans),
            (size(piece.length, piece.width), Face::Mono),
            (
                format!("{}", placed.get(index).copied().unwrap_or(0)),
                Face::Mono,
            ),
            (piece.order_number.clone(), Face::Mono),
            (piece.customer.clone().unwrap_or_default(), Face::Sans),
        ];
        let mut x = MARGIN;
        for ((width, _, right), (value, face)) in columns.iter().zip(cells.iter()) {
            if *right {
                w.doc
                    .text_right(w.page, *face, 8.5, x + width - 4.0, w.y + 10.5, value, 0.0);
            } else {
                w.doc.text_fit(
                    w.page,
                    *face,
                    8.5,
                    x + 4.0,
                    w.y + 10.5,
                    value,
                    width - 8.0,
                    0.0,
                );
            }
            x += width;
        }
        w.y += 15.0;
        w.doc.line(
            w.page,
            MARGIN,
            w.y,
            MARGIN + CONTENT,
            w.y,
            Stroke::solid(0.4, 0.8),
        );
    }

    // Fields to sign.
    w.room(60.0);
    w.y += 26.0;
    let field = CONTENT / 3.0;
    for (i, label) in [text::SHEET_DONE_BY, text::SHEET_DATE, text::SHEET_SIGNATURE]
        .iter()
        .enumerate()
    {
        let x = MARGIN + field * i as f64;
        w.doc.line(
            w.page,
            x,
            w.y + 14.0,
            x + field - 16.0,
            w.y + 14.0,
            Stroke::solid(0.6, 0.0),
        );
        w.doc
            .text(w.page, Face::Sans, 8.0, x, w.y + 25.0, label, 0.35);
    }

    // Page numbers once the count is known.
    let total = w.doc.page_count();
    for page in 0..total {
        let footer = format!(
            "{} {} {} {}",
            text::SHEET_PAGE,
            page + 1,
            text::SHEET_OF,
            total
        );
        w.doc.text_right(
            page,
            Face::Sans,
            7.5,
            MARGIN + CONTENT,
            PAGE_HEIGHT - 24.0,
            &footer,
            0.4,
        );
        w.doc.text(
            page,
            Face::Sans,
            7.5,
            MARGIN,
            PAGE_HEIGHT - 24.0,
            &format!("{} · {}", text::PLANNER, plan.id),
            0.4,
        );
    }
    Ok(w.doc.finish())
}

fn placed_counts(group: &Group) -> Vec<u32> {
    let mut counts = vec![0u32; group.pieces.len()];
    for layout in &group.layouts {
        for &index in layout
            .cuts
            .iter()
            .chain(layout.placements.iter().map(|p| &p.piece))
        {
            if let Some(count) = counts.get_mut(index) {
                *count += layout.count;
            }
        }
    }
    counts
}

#[allow(clippy::too_many_arguments)]
fn draw_bar(
    doc: &mut Document,
    page: usize,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    stock: &Stock,
    layout: &Layout,
    group: &Group,
) {
    let scale = width / stock.length;
    let fonts = doc.fonts();
    doc.rect(
        page,
        x,
        y,
        width,
        height,
        Some(0.97),
        Some(Stroke::solid(0.6, 0.3)),
    );
    if layout.trim > 0.0 {
        doc.hatch(
            page,
            x,
            y,
            layout.trim * scale,
            height,
            3.0,
            Stroke::solid(0.4, 0.45),
        );
    }
    let mut offset = layout.trim;
    for &index in &layout.cuts {
        let Some(piece) = group.pieces.get(index) else {
            continue;
        };
        let px = x + offset * scale;
        let pw = piece.length * scale;
        doc.rect(
            page,
            px,
            y + 3.0,
            pw,
            height - 6.0,
            Some(1.0),
            Some(Stroke::solid(0.6, 0.0)),
        );
        let label = format!("{} · {}", index + 1, mm(piece.length));
        if fonts.width(Face::Mono, &label, 7.0) < pw - 4.0 {
            doc.text_center(
                page,
                Face::Mono,
                7.0,
                px + pw / 2.0,
                y + height / 2.0 + 2.5,
                &label,
                0.0,
            );
        } else if fonts.width(Face::Mono, &format!("{}", index + 1), 7.0) < pw - 2.0 {
            doc.text_center(
                page,
                Face::Mono,
                7.0,
                px + pw / 2.0,
                y + height / 2.0 + 2.5,
                &format!("{}", index + 1),
                0.0,
            );
        }
        offset += piece.length + group.settings.kerf;
    }
    if layout.offcut > 0.0 {
        let ox = x + (stock.length - layout.offcut) * scale;
        let ow = layout.offcut * scale;
        if layout.offcut_kind.as_deref() == Some("remnant") {
            doc.rect(
                page,
                ox,
                y + 3.0,
                ow,
                height - 6.0,
                Some(0.97),
                Some(Stroke::dashed(0.6, 0.2, 2.0, 1.5)),
            );
            let label = format!("{} {}", text::REMNANT, mm(layout.offcut));
            if fonts.width(Face::Mono, &label, 7.0) < ow - 4.0 {
                doc.text_center(
                    page,
                    Face::Mono,
                    7.0,
                    ox + ow / 2.0,
                    y + height / 2.0 + 2.5,
                    &label,
                    0.25,
                );
            }
        } else {
            doc.hatch(page, ox, y, ow, height, 3.0, Stroke::solid(0.4, 0.45));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_sheet(
    doc: &mut Document,
    page: usize,
    x: f64,
    y: f64,
    scale: f64,
    stock: &Stock,
    layout: &Layout,
    group: &Group,
    guillotine: bool,
) {
    let fonts = doc.fonts();
    let w = stock.length * scale;
    let h = stock.width.unwrap_or(0.0) * scale;
    doc.hatch(page, x, y, w, h, 4.0, Stroke::solid(0.35, 0.55));
    doc.rect(page, x, y, w, h, None, Some(Stroke::solid(0.6, 0.3)));
    if layout.edge_trim > 0.0 {
        let t = layout.edge_trim * scale;
        doc.rect(page, x, y, t, h, Some(0.85), None);
        doc.rect(page, x, y, w, t, Some(0.85), None);
        if !guillotine {
            doc.rect(page, x + w - t, y, t, h, Some(0.85), None);
            doc.rect(page, x, y + h - t, w, t, Some(0.85), None);
        }
    }
    for r in &layout.remnants {
        let (rx, ry) = (
            x + r.x.unwrap_or(0.0) * scale,
            y + r.y.unwrap_or(0.0) * scale,
        );
        let (rw, rh) = (r.length * scale, r.width.unwrap_or(0.0) * scale);
        doc.rect(
            page,
            rx,
            ry,
            rw,
            rh,
            Some(0.97),
            Some(Stroke::dashed(0.6, 0.2, 2.0, 1.5)),
        );
        let label = format!("{} {}", text::REMNANT, size(r.length, r.width));
        if fonts.width(Face::Mono, &label, 7.0) < rw - 4.0 && rh > 10.0 {
            doc.text_center(
                page,
                Face::Mono,
                7.0,
                rx + rw / 2.0,
                ry + rh / 2.0 + 2.5,
                &label,
                0.25,
            );
        }
    }
    for p in &layout.placements {
        let Some(piece) = group.pieces.get(p.piece) else {
            continue;
        };
        let (length, width) = if p.rotated {
            (piece.width.unwrap_or(0.0), piece.length)
        } else {
            (piece.length, piece.width.unwrap_or(0.0))
        };
        let (px, py, pw, ph) = (
            x + p.x * scale,
            y + p.y * scale,
            length * scale,
            width * scale,
        );
        doc.rect(
            page,
            px,
            py,
            pw,
            ph,
            Some(1.0),
            Some(Stroke::solid(0.5, 0.0)),
        );
        let number = format!("{}", p.piece + 1);
        if ph > 9.0 && fonts.width(Face::Mono, &number, 7.0) < pw - 2.0 {
            let dims = size(length, Some(width));
            if ph > 20.0 && fonts.width(Face::Mono, &dims, 6.0) < pw - 4.0 {
                doc.text_center(
                    page,
                    Face::Mono,
                    7.0,
                    px + pw / 2.0,
                    py + ph / 2.0 - 1.0,
                    &number,
                    0.0,
                );
                doc.text_center(
                    page,
                    Face::Mono,
                    6.0,
                    px + pw / 2.0,
                    py + ph / 2.0 + 7.0,
                    &dims,
                    0.3,
                );
            } else {
                doc.text_center(
                    page,
                    Face::Mono,
                    7.0,
                    px + pw / 2.0,
                    py + ph / 2.0 + 2.5,
                    &number,
                    0.0,
                );
            }
        }
    }
    if guillotine {
        for [order, stage, x1, y1, x2, y2] in &layout.cut_lines {
            let stroke = if *stage == 3.0 {
                Stroke::dashed(0.5, 0.2, 2.0, 1.5)
            } else {
                Stroke::solid(if *stage <= 1.0 { 0.9 } else { 0.6 }, 0.2)
            };
            doc.line(
                page,
                x + x1 * scale,
                y + y1 * scale,
                x + x2 * scale,
                y + y2 * scale,
                stroke,
            );
            let vertical = (x2 - x1).abs() < (y2 - y1).abs();
            let length = ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt() * scale;
            if length >= 14.0 {
                let (cx, cy) = if vertical {
                    (x + x1 * scale, y + y1.min(*y2) * scale + 7.0)
                } else {
                    (x + x1.min(*x2) * scale + 7.0, y + y1 * scale)
                };
                doc.circle(page, cx, cy, 5.0, 1.0, Stroke::solid(0.5, 0.2));
                doc.text_center(
                    page,
                    Face::Mono,
                    5.5,
                    cx,
                    cy + 2.0,
                    &format!("{}", *order as u32),
                    0.0,
                );
            }
        }
    }
}

// ----------------------------------------------------------------- operation --

#[derive(Deserialize, Serialize, Default)]
struct Checkpoint {
    #[serde(default)]
    record_id: Option<String>,
    #[serde(default)]
    plan_id: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    total: usize,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    artifact: Option<String>,
}

fn rejected(code: &str, message: &str) -> Failure {
    Failure::Rejected(Rejection {
        code: code.into(),
        message: message.into(),
        record_id: None,
        connection: None,
    })
}

/// The saved plan that made this production order, and its group.
fn find_plan(record_id: &str) -> Result<Option<(Plan, usize, String)>, String> {
    for value in host::storage_list(plans::PREFIX, 1000)? {
        let Ok(plan) = serde_json::from_value::<Plan>(value) else {
            continue;
        };
        let Some(order) = plan.production_orders.iter().find(|p| p.id == record_id) else {
            continue;
        };
        let number = order.number.clone();
        let key = order.group_key.clone();
        if let Some(index) = plan.groups.iter().position(|g| g.key == key) {
            return Ok(Some((plan, index, number)));
        }
    }
    Ok(None)
}

pub fn prepare(_request: &OperationRequest) -> Result<String, String> {
    Ok("cutting sheet".into())
}

pub fn process_batch(request: &OperationRequest) -> Result<BatchOutcome, Failure> {
    let mut checkpoint: Checkpoint = if request.checkpoint.trim().is_empty() {
        Checkpoint::default()
    } else {
        serde_json::from_str(&request.checkpoint)
            .map_err(|_| rejected("invalid_checkpoint", "invalid checkpoint"))?
    };
    if checkpoint.record_id.is_none() {
        let page: Value = host::decode(&selection::page("", 1)?, "selection page")?;
        let member = &page["records"][0];
        if member["status"].as_str() != Some("available") {
            return Err(rejected("unavailable", text::SHEET_RECORD_UNAVAILABLE));
        }
        checkpoint.record_id = member["record_id"].as_str().map(str::to_owned);
    }
    let record_id = checkpoint.record_id.clone().unwrap_or_default();
    let Some((plan, index, number)) = find_plan(&record_id)? else {
        return Err(rejected("no_plan", text::SHEET_NO_PLAN));
    };
    let bytes = render(&plan, &plan.groups[index], &number)?;
    let name = format!("karta-ciecia-{}.pdf", number.replace(['/', '\\', ' '], "-"));
    checkpoint.plan_id = Some(plan.id.clone());
    checkpoint.total = bytes.len();
    checkpoint.name = Some(name.clone());
    let end = (checkpoint.offset + CHUNK).min(bytes.len());
    artifacts::append_output(
        &name,
        "application/pdf",
        &request.batch_key,
        &bytes[checkpoint.offset..end],
    )?;
    checkpoint.offset = end;
    let done = end >= bytes.len();
    if done {
        checkpoint.artifact = Some(artifacts::finalize_output(&name)?);
    }
    Ok(BatchOutcome {
        progress: json!({"completed": checkpoint.offset, "total": checkpoint.total.max(1)})
            .to_string(),
        checkpoint: serde_json::to_string(&checkpoint)
            .map_err(|_| rejected("invalid_checkpoint", "checkpoint"))?,
        done,
        resume_after_ms: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan() -> Plan {
        serde_json::from_value(json!({
            "id": "0123456789abcdef01234567",
            "created_at": "2026-11-27T21:00:00Z",
            "orders": [{"number": "ZK/2026/105"}],
            "production_orders": [{"id": "po", "number": "PC/01234567/1", "group_key": "s"}],
            "groups": [{
                "key": "s", "kind": "sheet", "label": "S235JR · 3 mm", "mode": "guillotine",
                "machine": {"name": "Gilotyna hydrauliczna", "process": "guillotine"},
                "settings": {"kerf": 0, "startTrim": 5, "spacing": 0, "minRemnant": 300},
                "stock": [{"label": "Blacha 3 mm 1500×3000", "length": 3000, "width": 1500}],
                "pieces": [
                    {"item_label": "Osłona · E-COVER", "length": 1200, "width": 600, "order_number": "ZK/2026/105", "customer": "Hale i Wiaty Nowak"},
                    {"item_label": "Blacha węzłowa · E-GUSSET", "length": 340, "width": 260, "order_number": "ZK/2026/105", "customer": "Hale i Wiaty Nowak"}
                ],
                "layouts": [{
                    "stock": 0, "count": 2, "edge_trim": 5,
                    "placements": [{"piece": 0, "x": 5, "y": 5, "rotated": false}, {"piece": 1, "x": 1205, "y": 5, "rotated": false}],
                    "cut_lines": [[1, 0, 5, 0, 5, 1500], [2, 0, 5, 5, 3000, 5], [3, 1, 1205, 5, 1205, 1500]],
                    "remnants": [{"x": 1545, "y": 5, "length": 1455, "width": 1495}]
                }],
                "figures": {"pieces": 2, "stockMeasure": 9000000, "partsMeasure": 1616800, "stockKg": 211.95, "partsKg": 38.1}
            }]
        }))
        .unwrap()
    }

    #[test]
    fn renders_a_small_pdf_with_polish_text() {
        let plan = plan();
        let bytes = render(&plan, &plan.groups[0], "PC/01234567/1").unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1.7"));
        assert!(text.contains("/FontFile2"));
        assert!(text.contains("/ToUnicode"));
        assert!(bytes.len() < CHUNK, "{} bytes", bytes.len());
    }

    /// Writes the sample to $CUTTING_SHEET_SAMPLE for a look (no assertion).
    #[test]
    fn writes_a_sample_when_asked() {
        if let Ok(path) = std::env::var("CUTTING_SHEET_SAMPLE") {
            let plan = plan();
            std::fs::write(
                path,
                render(&plan, &plan.groups[0], "PC/01234567/1").unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn rendering_is_deterministic() {
        let plan = plan();
        assert_eq!(
            render(&plan, &plan.groups[0], "PC/1").unwrap(),
            render(&plan, &plan.groups[0], "PC/1").unwrap()
        );
    }

    #[test]
    fn long_piece_lists_continue_on_new_pages() {
        let mut plan = plan();
        let piece = plan.groups[0].pieces[1].item_label.clone();
        for i in 0..80 {
            plan.groups[0].pieces.push(Piece {
                item_label: format!("{piece} {i}"),
                length: 100.0,
                width: Some(100.0),
                order_number: "ZK/2026/105".into(),
                customer: None,
            });
        }
        let bytes = render(&plan, &plan.groups[0], "PC/1").unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            text.contains("/Count 2") || text.contains("/Count 3"),
            "pages"
        );
    }

    #[test]
    fn numbers_group_thousands() {
        assert_eq!(mm(1250.0), "1250");
        assert_eq!(mm(12500.0), "12\u{2009}500");
        assert_eq!(mm(1497.5), "1497,5");
    }
}
