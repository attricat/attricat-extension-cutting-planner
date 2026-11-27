//! Every message the server shows a user, in Polish. Kept in one place so
//! English can be added later without touching the commands.

pub const NOT_WHOLE_PIECES: &str = "Ilość nie jest całkowitą liczbą sztuk.";
pub const NOT_CUT: &str = "Pozycja nie jest cięta ze sztangi ani z arkusza.";
pub const NO_WIDTH: &str = "Specyfikacja nie ma szerokości.";
pub const NO_SPECIFICATION: &str = "Wyrób nie ma specyfikacji.";
pub const NO_LENGTH: &str = "Specyfikacja nie ma długości.";
pub const NO_SECTION: &str = "Brakuje przekroju, gatunku lub grubości, które dobierają materiał.";
pub const INVALID_PLAN_ID: &str = "Nieprawidłowy identyfikator planu.";
pub const PLAN_TOO_LARGE: &str =
    "Plan jest zbyt duży, aby go zapisać. Podziel zamówienia na kilka planów.";
pub const PLAN_ALREADY_ORDERED: &str =
    "Z tego planu utworzono już zlecenia produkcyjne; nie można go zmienić.";
pub const PLAN_NOT_FOUND: &str = "Nie znaleziono planu. Zapisz go ponownie.";
pub const PLAN_EMPTY: &str = "Plan nie ma żadnej sztangi do cięcia.";
pub const PRODUCTION_ORDER_REJECTED: &str = "Nie udało się utworzyć zlecenia produkcyjnego.";
pub const PRODUCTION_LINE_REJECTED: &str = "Nie udało się dodać pozycji zlecenia produkcyjnego.";
pub const STOCK_WEIGHT_MISSING: &str =
    "Sztanga lub arkusz nie ma masy, a materiał zlecenia jest w kilogramach.";
pub const REMNANT: &str = "Pozostałość";
pub const REMNANT_REJECTED: &str = "Nie udało się zapisać pozostałości.";
pub const COMMAND_FAILED: &str = "Polecenie nie powiodło się.";
pub const CONFIGURATION_INVALID: &str = "Rozszerzenie nie jest poprawnie skonfigurowane:";

pub fn stale_quantity(item: &str, planned: f64, now: f64) -> String {
    format!("{item}: w planie {planned} szt., w zamówieniu teraz {now} szt.")
}

pub fn stale_line_gone(item: &str) -> String {
    format!("{item}: pozycji nie ma już w zamówieniu.")
}

pub fn stale_stock(label: &str, needed: u32, free: u32) -> String {
    format!("{label}: plan potrzebuje {needed} szt., wolnych jest {free}.")
}

// The cutting sheet.
pub const PLANNER: &str = "Planer cięcia";
pub const SHEET_TITLE: &str = "Karta cięcia";
pub const SHEET_MACHINE: &str = "Maszyna";
pub const SHEET_MATERIAL: &str = "Materiał";
pub const SHEET_ORDERS: &str = "Zamówienia";
pub const SHEET_PLAN: &str = "Plan cięcia";
pub const SHEET_SETTINGS: &str = "Ustawienia";
pub const SHEET_USAGE: &str = "Zużycie";
pub const SHEET_KERF: &str = "rzaz";
pub const SHEET_START_TRIM: &str = "obcięcie początku";
pub const SHEET_EDGE_TRIM: &str = "obcięcie krawędzi";
pub const SHEET_SPACING: &str = "odstęp";
pub const SHEET_MIN_REMNANT: &str = "pozostałość od";
pub const SHEET_UTILISATION: &str = "wykorzystanie";
pub const SHEET_LAYOUT: &str = "Układ";
pub const SHEET_LEGEND_PIECE: &str = "Detal";
pub const SHEET_LEGEND_SCRAP: &str = "Złom, obcięcie";
pub const SHEET_CUT_ORDER: &str = "Kolejność cięć: liczby na liniach. Najpierw obcięcie krawędzi, potem pasy w poprzek arkusza, detale w pasie i docięcia (linia przerywana).";
pub const SHEET_PIECES: &str = "Detale";
pub const SHEET_COL_NO: &str = "Nr";
pub const SHEET_COL_ITEM: &str = "Wyrób";
pub const SHEET_COL_SIZE: &str = "Wymiary [mm]";
pub const SHEET_COL_QUANTITY: &str = "Ilość";
pub const SHEET_COL_ORDER: &str = "Zamówienie";
pub const SHEET_COL_CUSTOMER: &str = "Klient";
pub const SHEET_DONE_BY: &str = "Wykonał";
pub const SHEET_DATE: &str = "Data";
pub const SHEET_SIGNATURE: &str = "Podpis";
pub const SHEET_PAGE: &str = "Strona";
pub const SHEET_OF: &str = "z";
pub const SHEET_RECORD_UNAVAILABLE: &str = "Zlecenie produkcyjne jest niedostępne.";
pub const SHEET_NO_PLAN: &str = "To zlecenie produkcyjne nie powstało z planu cięcia.";

pub fn process(process: &str) -> &'static str {
    match process {
        "saw" => "piła",
        "guillotine" => "gilotyna",
        "laser" => "laser",
        "plasma" => "plazma",
        _ => "",
    }
}

fn plural(n: u32, one: &'static str, few: &'static str, many: &'static str) -> &'static str {
    let (tens, units) = (n % 100, n % 10);
    if n == 1 {
        one
    } else if (2..=4).contains(&units) && !(12..=14).contains(&tens) {
        few
    } else {
        many
    }
}

pub fn bars(n: u32) -> String {
    format!("{n} {}", plural(n, "sztanga", "sztangi", "sztang"))
}

pub fn sheets(n: u32) -> String {
    format!("{n} {}", plural(n, "arkusz", "arkusze", "arkuszy"))
}
