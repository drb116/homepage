-- Migration number: 0001 	 2026-08-15T15:40:28.914Z
CREATE TABLE weekly_menus (
    week_start TEXT PRIMARY KEY,
    menu_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);