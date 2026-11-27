//! Just enough TrueType to embed a font in a PDF: the character map, glyph
//! advances and metrics, and a subset that keeps glyph IDs but drops the
//! outlines of glyphs the document does not use.

use std::collections::{BTreeSet, HashMap};

pub struct Font {
    data: &'static [u8],
    tables: HashMap<[u8; 4], (usize, usize)>,
    cmap: HashMap<u32, u16>,
    advances: Vec<u16>,
    pub units_per_em: u16,
    pub ascent: i16,
    pub descent: i16,
    pub bbox: [i16; 4],
    num_glyphs: u16,
}

fn u16_at(data: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([data[at], data[at + 1]])
}

fn i16_at(data: &[u8], at: usize) -> i16 {
    i16::from_be_bytes([data[at], data[at + 1]])
}

fn u32_at(data: &[u8], at: usize) -> u32 {
    u32::from_be_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
}

impl Font {
    pub fn parse(data: &'static [u8]) -> Result<Self, String> {
        let count = u16_at(data, 4) as usize;
        let mut tables = HashMap::new();
        for i in 0..count {
            let at = 12 + i * 16;
            let tag = [data[at], data[at + 1], data[at + 2], data[at + 3]];
            tables.insert(
                tag,
                (
                    u32_at(data, at + 8) as usize,
                    u32_at(data, at + 12) as usize,
                ),
            );
        }
        let table = |tag: &[u8; 4]| {
            tables
                .get(tag)
                .copied()
                .ok_or_else(|| format!("font has no {}", String::from_utf8_lossy(tag)))
        };
        let (head, _) = table(b"head")?;
        let (hhea, _) = table(b"hhea")?;
        let (maxp, _) = table(b"maxp")?;
        let (hmtx, _) = table(b"hmtx")?;
        let num_glyphs = u16_at(data, maxp + 4);
        let metrics = u16_at(data, hhea + 34) as usize;
        let mut advances = Vec::with_capacity(num_glyphs as usize);
        for gid in 0..num_glyphs as usize {
            advances.push(u16_at(data, hmtx + 4 * gid.min(metrics - 1)));
        }
        let mut font = Self {
            data,
            cmap: HashMap::new(),
            advances,
            units_per_em: u16_at(data, head + 18),
            ascent: i16_at(data, hhea + 4),
            descent: i16_at(data, hhea + 6),
            bbox: [
                i16_at(data, head + 36),
                i16_at(data, head + 38),
                i16_at(data, head + 40),
                i16_at(data, head + 42),
            ],
            num_glyphs,
            tables,
        };
        font.cmap = font.read_cmap()?;
        Ok(font)
    }

    /// The Unicode map from a format 12 or format 4 Windows subtable.
    fn read_cmap(&self) -> Result<HashMap<u32, u16>, String> {
        let data = self.data;
        let (cmap, _) = self
            .tables
            .get(b"cmap")
            .copied()
            .ok_or("font has no cmap")?;
        let count = u16_at(data, cmap + 2) as usize;
        let mut best: Option<(usize, u16)> = None;
        for i in 0..count {
            let at = cmap + 4 + i * 8;
            let (platform, encoding) = (u16_at(data, at), u16_at(data, at + 2));
            let offset = cmap + u32_at(data, at + 4) as usize;
            let format = u16_at(data, offset);
            if platform == 3 && ((encoding == 10 && format == 12) || (encoding == 1 && format == 4))
            {
                if best.is_none_or(|(_, f)| format > f) {
                    best = Some((offset, format));
                }
            }
        }
        let (offset, format) = best.ok_or("font has no Unicode cmap")?;
        let mut map = HashMap::new();
        if format == 12 {
            let groups = u32_at(data, offset + 12) as usize;
            for g in 0..groups {
                let at = offset + 16 + g * 12;
                let (start, end, glyph) =
                    (u32_at(data, at), u32_at(data, at + 4), u32_at(data, at + 8));
                for code in start..=end {
                    map.insert(code, (glyph + code - start) as u16);
                }
            }
        } else {
            let segments = u16_at(data, offset + 6) as usize / 2;
            let ends = offset + 14;
            let starts = ends + segments * 2 + 2;
            let deltas = starts + segments * 2;
            let ranges = deltas + segments * 2;
            for s in 0..segments {
                let (end, start) = (u16_at(data, ends + s * 2), u16_at(data, starts + s * 2));
                let delta = u16_at(data, deltas + s * 2);
                let range = u16_at(data, ranges + s * 2) as usize;
                for code in start..=end {
                    if code == 0xffff {
                        break;
                    }
                    let glyph = if range == 0 {
                        code.wrapping_add(delta)
                    } else {
                        let at = ranges + s * 2 + range + (code - start) as usize * 2;
                        match u16_at(data, at) {
                            0 => 0,
                            g => g.wrapping_add(delta),
                        }
                    };
                    if glyph != 0 {
                        map.insert(u32::from(code), glyph);
                    }
                }
            }
        }
        Ok(map)
    }

    pub fn glyph(&self, c: char) -> u16 {
        self.cmap
            .get(&(c as u32))
            .copied()
            .or_else(|| self.cmap.get(&('?' as u32)).copied())
            .unwrap_or(0)
    }

    /// Advance width in thousandths of the font size, as PDF measures it.
    pub fn advance(&self, gid: u16) -> f64 {
        f64::from(self.advances.get(gid as usize).copied().unwrap_or(0)) * 1000.0
            / f64::from(self.units_per_em)
    }

    pub fn width(&self, text: &str, size: f64) -> f64 {
        text.chars()
            .map(|c| self.advance(self.glyph(c)))
            .sum::<f64>()
            * size
            / 1000.0
    }

    fn table(&self, tag: &[u8; 4]) -> Option<&'static [u8]> {
        self.tables
            .get(tag)
            .map(|&(offset, length)| &self.data[offset..offset + length])
    }

    /// The font with only `used` glyphs (and the parts of composite glyphs
    /// they use) left in `glyf`; glyph IDs stay the same, so text written
    /// with them still points at the right glyphs.
    pub fn subset(&self, used: &BTreeSet<u16>) -> Vec<u8> {
        let head = self.table(b"head").unwrap_or_default();
        let loca = self.table(b"loca").unwrap_or_default();
        let glyf = self.table(b"glyf").unwrap_or_default();
        let long = head.len() >= 52 && i16_at(head, 50) == 1;
        let location = |gid: usize| -> usize {
            if long {
                u32_at(loca, gid * 4) as usize
            } else {
                u16_at(loca, gid * 2) as usize * 2
            }
        };
        let glyph_data = |gid: u16| -> &[u8] {
            let gid = gid as usize;
            if gid >= self.num_glyphs as usize {
                return &[];
            }
            let (start, end) = (location(gid), location(gid + 1));
            if end > start && end <= glyf.len() {
                &glyf[start..end]
            } else {
                &[]
            }
        };

        let mut keep: BTreeSet<u16> = used.clone();
        keep.insert(0);
        let mut queue: Vec<u16> = keep.iter().copied().collect();
        while let Some(gid) = queue.pop() {
            let data = glyph_data(gid);
            if data.len() < 10 || i16_at(data, 0) >= 0 {
                continue;
            }
            // A composite glyph: follow its components.
            let mut at = 10;
            loop {
                if at + 4 > data.len() {
                    break;
                }
                let flags = u16_at(data, at);
                let component = u16_at(data, at + 2);
                if keep.insert(component) {
                    queue.push(component);
                }
                at += 4 + if flags & 1 != 0 { 4 } else { 2 };
                at += if flags & 0x8 != 0 {
                    2
                } else if flags & 0x40 != 0 {
                    4
                } else if flags & 0x80 != 0 {
                    8
                } else {
                    0
                };
                if flags & 0x20 == 0 {
                    break;
                }
            }
        }

        let mut new_glyf = Vec::new();
        let mut new_loca = Vec::with_capacity((self.num_glyphs as usize + 1) * 4);
        for gid in 0..self.num_glyphs {
            new_loca.extend_from_slice(&(new_glyf.len() as u32).to_be_bytes());
            if keep.contains(&gid) {
                new_glyf.extend_from_slice(glyph_data(gid));
                while new_glyf.len() % 4 != 0 {
                    new_glyf.push(0);
                }
            }
        }
        new_loca.extend_from_slice(&(new_glyf.len() as u32).to_be_bytes());
        let mut new_head = head.to_vec();
        if new_head.len() >= 52 {
            new_head[8..12].copy_from_slice(&[0; 4]);
            new_head[50..52].copy_from_slice(&1i16.to_be_bytes());
        }

        let mut tables: Vec<([u8; 4], Vec<u8>)> = Vec::new();
        let mut tags: Vec<[u8; 4]> = self.tables.keys().copied().collect();
        tags.sort();
        for tag in tags {
            let data = match &tag {
                b"glyf" => new_glyf.clone(),
                b"loca" => new_loca.clone(),
                b"head" => new_head.clone(),
                _ => self.table(&tag).unwrap_or_default().to_vec(),
            };
            tables.push((tag, data));
        }
        write_sfnt(&tables)
    }
}

fn checksum(data: &[u8]) -> u32 {
    data.chunks(4).fold(0u32, |sum, chunk| {
        let mut word = [0u8; 4];
        word[..chunk.len()].copy_from_slice(chunk);
        sum.wrapping_add(u32::from_be_bytes(word))
    })
}

fn write_sfnt(tables: &[([u8; 4], Vec<u8>)]) -> Vec<u8> {
    let n = tables.len() as u16;
    let selector = 15 - n.leading_zeros() as u16;
    let range = (1u16 << selector) * 16;
    let mut out = Vec::new();
    out.extend_from_slice(&0x0001_0000u32.to_be_bytes());
    for value in [n, range, selector, n * 16 - range] {
        out.extend_from_slice(&value.to_be_bytes());
    }
    let mut offset = 12 + tables.len() * 16;
    for (tag, data) in tables {
        out.extend_from_slice(tag);
        out.extend_from_slice(&checksum(data).to_be_bytes());
        out.extend_from_slice(&(offset as u32).to_be_bytes());
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += data.len().div_ceil(4) * 4;
    }
    let mut head_at = None;
    for (tag, data) in tables {
        if tag == b"head" {
            head_at = Some(out.len());
        }
        out.extend_from_slice(data);
        while out.len() % 4 != 0 {
            out.push(0);
        }
    }
    if let Some(at) = head_at {
        let adjustment = 0xb1b0_afbau32.wrapping_sub(checksum(&out));
        out[at + 8..at + 12].copy_from_slice(&adjustment.to_be_bytes());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    static SANS: &[u8] = include_bytes!("../../fonts/IBMPlexSans-Regular.ttf");

    #[test]
    fn maps_polish_letters_and_measures_text() {
        let font = Font::parse(SANS).unwrap();
        for c in "ąćęłńóśźżĄĆĘŁŃÓŚŹŻ×·".chars() {
            assert_ne!(font.glyph(c), 0, "no glyph for {c}");
        }
        assert!(font.width("Karta cięcia", 10.0) > 40.0);
        assert_eq!(font.width("", 10.0), 0.0);
    }

    #[test]
    fn a_subset_is_smaller_and_still_parses() {
        let font = Font::parse(SANS).unwrap();
        let used: BTreeSet<u16> = "Karta cięcia 1250 × 600"
            .chars()
            .map(|c| font.glyph(c))
            .collect();
        let subset = font.subset(&used);
        assert!(subset.len() < SANS.len() / 2, "{} bytes", subset.len());
        let leaked: &'static [u8] = Box::leak(subset.into_boxed_slice());
        let again = Font::parse(leaked).unwrap();
        assert_eq!(again.glyph('ę'), font.glyph('ę'));
        assert_eq!(
            again.advance(font.glyph('K')),
            font.advance(font.glyph('K'))
        );
    }
}
