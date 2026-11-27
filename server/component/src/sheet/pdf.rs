//! A small PDF writer for A4 pages of vector drawings and text, with subset
//! TrueType fonts embedded as Type0 fonts (Identity-H), so Polish text prints
//! and copies correctly. Coordinates are points from the top-left corner.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt::Write;

use miniz_oxide::deflate::compress_to_vec_zlib;

use super::ttf::Font;

pub const PAGE_WIDTH: f64 = 595.28;
pub const PAGE_HEIGHT: f64 = 841.89;

/// Fonts by role: regular text, headings, and figures (monospace).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Face {
    Sans = 0,
    Bold = 1,
    Mono = 2,
}

pub struct Fonts {
    pub faces: [Font; 3],
    names: [&'static str; 3],
}

impl Fonts {
    pub fn load() -> Result<Self, String> {
        static SANS: &[u8] = include_bytes!("../../fonts/IBMPlexSans-Regular.ttf");
        static BOLD: &[u8] = include_bytes!("../../fonts/IBMPlexSans-SemiBold.ttf");
        static MONO: &[u8] = include_bytes!("../../fonts/IBMPlexMono-Regular.ttf");
        Ok(Self {
            faces: [Font::parse(SANS)?, Font::parse(BOLD)?, Font::parse(MONO)?],
            names: [
                "IBMPlexSans-Regular",
                "IBMPlexSans-SemiBold",
                "IBMPlexMono-Regular",
            ],
        })
    }

    pub fn width(&self, face: Face, text: &str, size: f64) -> f64 {
        self.faces[face as usize].width(text, size)
    }
}

fn num(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if rounded == rounded.trunc() {
        format!("{}", rounded as i64)
    } else {
        format!("{rounded}")
    }
}

/// A stroke: width in points, gray level (0 black, 1 white), dash pattern.
#[derive(Clone, Copy)]
pub struct Stroke {
    pub width: f64,
    pub gray: f64,
    pub dash: Option<(f64, f64)>,
}

impl Stroke {
    pub const fn solid(width: f64, gray: f64) -> Self {
        Self {
            width,
            gray,
            dash: None,
        }
    }
    pub const fn dashed(width: f64, gray: f64, on: f64, off: f64) -> Self {
        Self {
            width,
            gray,
            dash: Some((on, off)),
        }
    }
}

pub struct Page {
    ops: String,
}

pub struct Document<'f> {
    fonts: &'f Fonts,
    pages: Vec<Page>,
    used: [BTreeMap<u16, char>; 3],
}

impl<'f> Document<'f> {
    pub fn new(fonts: &'f Fonts) -> Self {
        Self {
            fonts,
            pages: Vec::new(),
            used: Default::default(),
        }
    }

    pub fn fonts(&self) -> &'f Fonts {
        self.fonts
    }

    pub fn add_page(&mut self) -> usize {
        self.pages.push(Page { ops: String::new() });
        self.pages.len() - 1
    }

    pub fn page_count(&self) -> usize {
        self.pages.len()
    }

    fn ops(&mut self, page: usize) -> &mut String {
        &mut self.pages[page].ops
    }

    fn stroke_state(out: &mut String, stroke: Stroke) {
        let _ = write!(out, "{} w {} G ", num(stroke.width), num(stroke.gray));
        match stroke.dash {
            Some((on, off)) => {
                let _ = write!(out, "[{} {}] 0 d ", num(on), num(off));
            }
            None => out.push_str("[] 0 d "),
        }
    }

    /// Text with its baseline at `y`.
    pub fn text(
        &mut self,
        page: usize,
        face: Face,
        size: f64,
        x: f64,
        y: f64,
        text: &str,
        gray: f64,
    ) {
        let font = &self.fonts.faces[face as usize];
        let mut hex = String::with_capacity(text.len() * 4);
        for c in text.chars() {
            let gid = font.glyph(c);
            self.used[face as usize].entry(gid).or_insert(c);
            let _ = write!(hex, "{gid:04X}");
        }
        let ops = self.ops(page);
        let _ = writeln!(
            ops,
            "BT {} g /F{} {} Tf {} {} Td <{hex}> Tj ET",
            num(gray),
            face as usize,
            num(size),
            num(x),
            num(PAGE_HEIGHT - y)
        );
    }

    /// Text shortened with an ellipsis to fit `max_width`.
    pub fn text_fit(
        &mut self,
        page: usize,
        face: Face,
        size: f64,
        x: f64,
        y: f64,
        text: &str,
        max_width: f64,
        gray: f64,
    ) {
        let fonts = self.fonts;
        if fonts.width(face, text, size) <= max_width {
            return self.text(page, face, size, x, y, text, gray);
        }
        let mut shortened: String = text.to_owned();
        while !shortened.is_empty() && fonts.width(face, &format!("{shortened}…"), size) > max_width
        {
            shortened.pop();
        }
        self.text(
            page,
            face,
            size,
            x,
            y,
            &format!("{}…", shortened.trim_end()),
            gray,
        );
    }

    pub fn text_right(
        &mut self,
        page: usize,
        face: Face,
        size: f64,
        right: f64,
        y: f64,
        text: &str,
        gray: f64,
    ) {
        let width = self.fonts.width(face, text, size);
        self.text(page, face, size, right - width, y, text, gray);
    }

    pub fn text_center(
        &mut self,
        page: usize,
        face: Face,
        size: f64,
        cx: f64,
        y: f64,
        text: &str,
        gray: f64,
    ) {
        let width = self.fonts.width(face, text, size);
        self.text(page, face, size, cx - width / 2.0, y, text, gray);
    }

    pub fn line(&mut self, page: usize, x1: f64, y1: f64, x2: f64, y2: f64, stroke: Stroke) {
        let ops = self.ops(page);
        Self::stroke_state(ops, stroke);
        let _ = writeln!(
            ops,
            "{} {} m {} {} l S",
            num(x1),
            num(PAGE_HEIGHT - y1),
            num(x2),
            num(PAGE_HEIGHT - y2)
        );
    }

    pub fn rect(
        &mut self,
        page: usize,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        fill: Option<f64>,
        stroke: Option<Stroke>,
    ) {
        let ops = self.ops(page);
        if let Some(stroke) = stroke {
            Self::stroke_state(ops, stroke);
        }
        if let Some(gray) = fill {
            let _ = write!(ops, "{} g ", num(gray));
        }
        let paint = match (fill.is_some(), stroke.is_some()) {
            (true, true) => "B",
            (true, false) => "f",
            (false, true) => "S",
            (false, false) => "n",
        };
        let _ = writeln!(
            ops,
            "{} {} {} {} re {paint}",
            num(x),
            num(PAGE_HEIGHT - y - h),
            num(w),
            num(h)
        );
    }

    /// Diagonal hatch inside a rectangle: the drawings' sign for scrap.
    pub fn hatch(
        &mut self,
        page: usize,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        spacing: f64,
        stroke: Stroke,
    ) {
        if w <= 0.0 || h <= 0.0 {
            return;
        }
        let ops = self.ops(page);
        let _ = writeln!(
            ops,
            "q {} {} {} {} re W n",
            num(x),
            num(PAGE_HEIGHT - y - h),
            num(w),
            num(h)
        );
        Self::stroke_state(ops, stroke);
        let mut offset = -h;
        while offset < w {
            let (x1, y1) = (x + offset, y + h);
            let (x2, y2) = (x + offset + h, y);
            let _ = writeln!(
                ops,
                "{} {} m {} {} l S",
                num(x1),
                num(PAGE_HEIGHT - y1),
                num(x2),
                num(PAGE_HEIGHT - y2)
            );
            offset += spacing;
        }
        ops.push_str("Q\n");
    }

    pub fn circle(&mut self, page: usize, cx: f64, cy: f64, r: f64, fill: f64, stroke: Stroke) {
        let k = 0.5523 * r;
        let y = PAGE_HEIGHT - cy;
        let ops = self.ops(page);
        Self::stroke_state(ops, stroke);
        let _ = writeln!(
            ops,
            "{} g {} {} m {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c {} {} {} {} {} {} c B",
            num(fill),
            num(cx + r),
            num(y),
            num(cx + r),
            num(y + k),
            num(cx + k),
            num(y + r),
            num(cx),
            num(y + r),
            num(cx - k),
            num(y + r),
            num(cx - r),
            num(y + k),
            num(cx - r),
            num(y),
            num(cx - r),
            num(y - k),
            num(cx - k),
            num(y - r),
            num(cx),
            num(y - r),
            num(cx + k),
            num(y - r),
            num(cx + r),
            num(y - k),
            num(cx + r),
            num(y),
        );
    }

    pub fn finish(self) -> Vec<u8> {
        let mut objects: Vec<Vec<u8>> = Vec::new();
        // 1: catalog, 2: pages; then fonts, then each page and its content.
        objects.push(b"<< /Type /Catalog /Pages 2 0 R >>".to_vec());
        objects.push(Vec::new());
        let stream = |dict: &str, data: &[u8]| -> Vec<u8> {
            let compressed = compress_to_vec_zlib(data, 6);
            let mut out = format!(
                "<< {dict} /Filter /FlateDecode /Length {} >>\nstream\n",
                compressed.len()
            )
            .into_bytes();
            out.extend_from_slice(&compressed);
            out.extend_from_slice(b"\nendstream");
            out
        };

        let mut font_refs = Vec::new();
        for (index, font) in self.fonts.faces.iter().enumerate() {
            let used = &self.used[index];
            let gids: BTreeSet<u16> = used.keys().copied().collect();
            let subset = font.subset(&gids);
            let name = format!(
                "AAAAA{}+{}",
                (b'A' + index as u8) as char,
                self.fonts.names[index]
            );
            let scale = 1000.0 / f64::from(font.units_per_em);
            let file = objects.len() + 1;
            objects.push(stream(&format!("/Length1 {}", subset.len()), &subset));
            let descriptor = objects.len() + 1;
            let b = font.bbox.map(|v| num(f64::from(v) * scale));
            objects.push(
                format!(
                    "<< /Type /FontDescriptor /FontName /{name} /Flags 32 /FontBBox [{} {} {} {}] /ItalicAngle 0 /Ascent {} /Descent {} /CapHeight {} /StemV 80 /FontFile2 {file} 0 R >>",
                    b[0], b[1], b[2], b[3],
                    num(f64::from(font.ascent) * scale),
                    num(f64::from(font.descent) * scale),
                    num(f64::from(font.ascent) * scale * 0.7),
                )
                .into_bytes(),
            );
            let widths: String = gids
                .iter()
                .map(|&g| format!("{g} [{}]", num(font.advance(g))))
                .collect::<Vec<_>>()
                .join(" ");
            let cid = objects.len() + 1;
            objects.push(
                format!(
                    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{name} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor} 0 R /DW 1000 /W [{widths}] /CIDToGIDMap /Identity >>"
                )
                .into_bytes(),
            );
            let mut cmap = String::from(
                "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n",
            );
            for chunk in used.iter().collect::<Vec<_>>().chunks(100) {
                let _ = writeln!(cmap, "{} beginbfchar", chunk.len());
                for (gid, c) in chunk {
                    let mut units = [0u16; 2];
                    let hex: String = c
                        .encode_utf16(&mut units)
                        .iter()
                        .map(|u| format!("{u:04X}"))
                        .collect();
                    let _ = writeln!(cmap, "<{gid:04X}> <{hex}>");
                }
                cmap.push_str("endbfchar\n");
            }
            cmap.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
            let to_unicode = objects.len() + 1;
            objects.push(stream("", cmap.as_bytes()));
            let type0 = objects.len() + 1;
            objects.push(
                format!(
                    "<< /Type /Font /Subtype /Type0 /BaseFont /{name} /Encoding /Identity-H /DescendantFonts [{cid} 0 R] /ToUnicode {to_unicode} 0 R >>"
                )
                .into_bytes(),
            );
            font_refs.push(type0);
        }
        let resources = format!(
            "<< /Font << /F0 {} 0 R /F1 {} 0 R /F2 {} 0 R >> >>",
            font_refs[0], font_refs[1], font_refs[2]
        );
        let mut kids = Vec::new();
        for page in &self.pages {
            let content = objects.len() + 1;
            objects.push(stream("", page.ops.as_bytes()));
            let page_object = objects.len() + 1;
            objects.push(
                format!(
                    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {} {}] /Resources {resources} /Contents {content} 0 R >>",
                    num(PAGE_WIDTH),
                    num(PAGE_HEIGHT)
                )
                .into_bytes(),
            );
            kids.push(format!("{page_object} 0 R"));
        }
        objects[1] = format!(
            "<< /Type /Pages /Kids [{}] /Count {} >>",
            kids.join(" "),
            kids.len()
        )
        .into_bytes();

        let mut out = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n".to_vec();
        let mut offsets = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.extend_from_slice(format!("{} 0 obj\n", index + 1).as_bytes());
            out.extend_from_slice(object);
            out.extend_from_slice(b"\nendobj\n");
        }
        let xref = out.len();
        let mut table = format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
        for offset in offsets {
            let _ = writeln!(table, "{offset:010} 00000 n ");
        }
        let _ = write!(
            table,
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1
        );
        out.extend_from_slice(table.as_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_parseable_document_with_offsets_that_point_at_objects() {
        let fonts = Fonts::load().unwrap();
        let mut doc = Document::new(&fonts);
        let page = doc.add_page();
        doc.text(
            page,
            Face::Bold,
            18.0,
            36.0,
            60.0,
            "Karta cięcia — zażółć gęślą jaźń",
            0.0,
        );
        doc.rect(
            page,
            36.0,
            80.0,
            200.0,
            30.0,
            Some(0.95),
            Some(Stroke::solid(1.0, 0.0)),
        );
        doc.hatch(page, 236.0, 80.0, 50.0, 30.0, 4.0, Stroke::solid(0.4, 0.5));
        doc.circle(page, 100.0, 200.0, 6.0, 1.0, Stroke::solid(0.5, 0.0));
        let bytes = doc.finish();
        let text = String::from_utf8_lossy(&bytes);
        assert!(text.starts_with("%PDF-1.7"));
        assert!(text.ends_with("%%EOF\n"));
        let find = |needle: &[u8]| {
            bytes
                .windows(needle.len())
                .rposition(|w| w == needle)
                .unwrap()
        };
        let start = find(b"startxref\n") + 10;
        let end = start + bytes[start..].iter().position(|&b| b == b'\n').unwrap();
        let xref_at: usize = std::str::from_utf8(&bytes[start..end])
            .unwrap()
            .parse()
            .unwrap();
        assert!(bytes[xref_at..].starts_with(b"xref"));
        let table = std::str::from_utf8(&bytes[xref_at..]).unwrap();
        for (index, line) in table
            .lines()
            .skip(3)
            .take_while(|l| l.ends_with(" n "))
            .enumerate()
        {
            let offset: usize = line[..10].parse().unwrap();
            assert!(
                bytes[offset..].starts_with(format!("{} 0 obj", index + 1).as_bytes()),
                "object {}",
                index + 1
            );
        }
        // Subset fonts keep the document small.
        assert!(bytes.len() < 60_000, "{} bytes", bytes.len());
    }
}
