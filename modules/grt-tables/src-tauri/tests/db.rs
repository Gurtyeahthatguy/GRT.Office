//! The database side of the program, tested against SQLite itself.

use std::fs;

use grt_tables_lib::db::{
    self, check_ident, delete_row, describe_table, insert_row, is_unbounded_write, is_write,
    list_tables, quote_ident, select_page, update_row, Database,
};
use grt_tables_lib::export;
use grt_tables_lib::undo;

use std::collections::HashMap;

fn memory() -> Database {
    Database::create(None).expect("a database in memory")
}

fn values(pairs: &[(&str, serde_json::Value)]) -> HashMap<String, serde_json::Value> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

fn contacts(database: &Database) {
    database
        .connection
        .execute_batch(
            "CREATE TABLE contacts (
                 id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 note TEXT
             );",
        )
        .expect("a table");
}

// Injection.

#[test]
fn a_value_full_of_punctuation_survives_unchanged() {
    let database = memory();
    contacts(&database);

    let hostile = "O'Brien\"; DROP TABLE contacts; -- \\ ';";
    insert_row(
        &database.connection,
        "contacts",
        &values(&[("name", serde_json::json!(hostile))]),
    )
    .expect("the insert");

    let back: String = database
        .connection
        .query_row("SELECT name FROM contacts", [], |row| row.get(0))
        .expect("the row");

    assert_eq!(back, hostile);

    // And the table it tried to drop is still there.
    assert_eq!(list_tables(&database.connection).unwrap().len(), 1);
}

#[test]
fn a_table_named_like_an_attack_is_still_only_a_name() {
    let database = memory();
    let awkward = "odd\"name; DROP TABLE x";

    database
        .connection
        .execute_batch(&format!(
            "CREATE TABLE {} (v TEXT);",
            quote_ident(awkward)
        ))
        .expect("the table");

    let tables = list_tables(&database.connection).unwrap();
    assert_eq!(tables[0]["name"], serde_json::json!(awkward));

    // And it can be read back through the ordinary path.
    let page = select_page(&database.connection, awkward, 10, 0, None, false, None, None)
        .expect("a page");
    assert_eq!(page["total"], serde_json::json!(0));
}

#[test]
fn identifiers_are_quoted_by_doubling() {
    assert_eq!(quote_ident("plain"), "\"plain\"");
    assert_eq!(quote_ident("has\"quote"), "\"has\"\"quote\"");
}

#[test]
fn impossible_names_are_refused_early() {
    assert!(check_ident("").is_err());
    assert!(check_ident("with\nnewline").is_err());
    assert!(check_ident("with\0null").is_err());
    assert!(check_ident("ordinary").is_ok());
}

#[test]
fn a_filter_with_no_column_looks_in_every_column() {
    let database = memory();
    contacts(&database);
    for (name, note) in [("Pencil", "wood"), ("Notebook", "paper"), ("Eraser", "rubber, pencil friend")] {
        insert_row(
            &database.connection,
            "contacts",
            &values(&[("name", serde_json::json!(name)), ("note", serde_json::json!(note))]),
        )
        .unwrap();
    }
    let total = |column: Option<&str>, value: &str| {
        select_page(&database.connection, "contacts", 10, 0, None, false, column, Some(value)).unwrap()["total"].clone()
    };
    assert_eq!(total(None, "pencil"), serde_json::json!(2));
    assert_eq!(total(Some("name"), "pencil"), serde_json::json!(1));
}

#[test]
fn an_empty_filter_keeps_rows_with_nothing_in_the_column() {
    let database = memory();
    contacts(&database);
    insert_row(&database.connection, "contacts", &values(&[("name", serde_json::json!("no note"))])).unwrap();
    let page = select_page(&database.connection, "contacts", 10, 0, None, false, Some("note"), Some("")).unwrap();
    assert_eq!(page["total"], serde_json::json!(1));
}

#[test]
fn a_filter_value_is_bound_and_not_pasted() {
    let database = memory();
    contacts(&database);

    for name in ["Alice", "Bob'; DELETE FROM contacts; --"] {
        insert_row(
            &database.connection,
            "contacts",
            &values(&[("name", serde_json::json!(name))]),
        )
        .unwrap();
    }

    let page = select_page(
        &database.connection,
        "contacts",
        10,
        0,
        None,
        false,
        Some("name"),
        Some("'; DELETE"),
    )
    .expect("a filtered page");

    assert_eq!(page["total"], serde_json::json!(1));

    // Both rows are still there: the filter matched, it did not execute.
    let remaining: i64 = database
        .connection
        .query_row("SELECT COUNT(*) FROM contacts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(remaining, 2);
}

// Pagination.

#[test]
fn a_large_table_is_read_a_page_at_a_time() {
    let database = memory();
    contacts(&database);

    database.connection.execute_batch("BEGIN;").unwrap();
    {
        let mut statement = database
            .connection
            .prepare("INSERT INTO contacts (name) VALUES (?1)")
            .unwrap();
        for i in 0..100_000 {
            statement.execute([format!("person {i}")]).unwrap();
        }
    }
    database.connection.execute_batch("COMMIT;").unwrap();

    let page = select_page(&database.connection, "contacts", 20, 0, None, false, None, None)
        .expect("the first page");

    assert_eq!(page["total"], serde_json::json!(100_000));
    assert_eq!(page["rows"].as_array().unwrap().len(), 20);

    let far = select_page(
        &database.connection,
        "contacts",
        20,
        99_980,
        None,
        false,
        None,
        None,
    )
    .expect("the last page");
    assert_eq!(far["rows"].as_array().unwrap().len(), 20);
}

#[test]
fn a_page_can_be_ordered_and_the_order_is_a_column_not_a_string() {
    let database = memory();
    contacts(&database);
    for name in ["Charlie", "Alice", "Bob"] {
        insert_row(
            &database.connection,
            "contacts",
            &values(&[("name", serde_json::json!(name))]),
        )
        .unwrap();
    }

    let page = select_page(
        &database.connection,
        "contacts",
        10,
        0,
        Some("name"),
        false,
        None,
        None,
    )
    .unwrap();

    let first = &page["rows"][0];
    assert_eq!(first[2], serde_json::json!("Alice"));

    assert!(select_page(
        &database.connection,
        "contacts",
        10,
        0,
        Some("name; DROP TABLE contacts"),
        false,
        None,
        None
    )
    .is_err() || list_tables(&database.connection).unwrap().len() == 1);
}

// Writing.

#[test]
fn rows_are_written_read_changed_and_removed() {
    let database = memory();
    contacts(&database);

    let rowid = insert_row(
        &database.connection,
        "contacts",
        &values(&[("name", serde_json::json!("Ada")), ("note", serde_json::json!("first"))]),
    )
    .unwrap();

    let changed = update_row(
        &database.connection,
        "contacts",
        rowid,
        &values(&[("note", serde_json::json!("second"))]),
    )
    .unwrap();
    assert_eq!(changed, 1);

    let note: String = database
        .connection
        .query_row("SELECT note FROM contacts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(note, "second");

    assert_eq!(delete_row(&database.connection, "contacts", rowid).unwrap(), 1);
}

#[test]
fn a_constraint_is_enforced_rather_than_worked_around() {
    let database = memory();
    contacts(&database);
    assert!(insert_row(
        &database.connection,
        "contacts",
        &values(&[("note", serde_json::json!("no name"))])
    )
    .is_err());
}

#[test]
fn foreign_keys_are_switched_on() {
    let database = memory();
    database
        .connection
        .execute_batch(
            "CREATE TABLE parent (id INTEGER PRIMARY KEY);
             CREATE TABLE child (id INTEGER PRIMARY KEY,
                 parent_id INTEGER REFERENCES parent(id));",
        )
        .unwrap();

    // Off by default in SQLite, which would make every foreign key
    // decorative.
    assert!(insert_row(
        &database.connection,
        "child",
        &values(&[("parent_id", serde_json::json!(999))])
    )
    .is_err());
}

// Undo.

fn names(database: &Database, table: &str) -> Vec<String> {
    let mut statement = database
        .connection
        .prepare(&format!("SELECT name FROM {} ORDER BY rowid", quote_ident(table)))
        .unwrap();
    let rows = statement.query_map([], |row| row.get(0)).unwrap();
    rows.map(Result::unwrap).collect()
}

fn add(database: &mut Database, name: &str) -> i64 {
    undo::step(database, None, |connection| {
        insert_row(connection, "contacts", &values(&[("name", serde_json::json!(name))]))
    })
    .unwrap()
}

fn schema(database: &mut Database, sql: &str) {
    undo::step(database, Some(sql), |connection| connection.execute_batch(sql).map_err(|e| format!("{e}"))).unwrap();
}

#[test]
fn undo_takes_back_an_added_row_and_keeps_the_ones_before() {
    let mut database = memory();
    contacts(&database);
    add(&mut database, "kept");
    add(&mut database, "undone");

    assert!(undo::undo(&mut database).unwrap());
    assert_eq!(names(&database, "contacts"), vec!["kept"]);
    assert!(undo::undo(&mut database).unwrap());
    assert!(names(&database, "contacts").is_empty());
    assert!(!undo::undo(&mut database).unwrap());
}

#[test]
fn undo_puts_back_a_changed_value_and_a_deleted_row() {
    let mut database = memory();
    contacts(&database);
    let ada = add(&mut database, "Ada");
    let alan = add(&mut database, "Alan");

    undo::step(&mut database, None, |connection| {
        update_row(connection, "contacts", ada, &values(&[("name", serde_json::json!("Countess"))]))
    })
    .unwrap();
    undo::step(&mut database, None, |connection| delete_row(connection, "contacts", alan)).unwrap();
    assert_eq!(names(&database, "contacts"), vec!["Countess"]);

    undo::undo(&mut database).unwrap();
    assert_eq!(names(&database, "contacts"), vec!["Countess", "Alan"]);
    undo::undo(&mut database).unwrap();
    assert_eq!(names(&database, "contacts"), vec!["Ada", "Alan"]);
}

#[test]
fn undo_brings_back_rows_a_cascade_removed() {
    let mut database = memory();
    schema(
        &mut database,
        "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT);
         CREATE TABLE child (id INTEGER PRIMARY KEY, name TEXT, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
         INSERT INTO parent VALUES (1, 'p');
         INSERT INTO child VALUES (1, 'c1', 1), (2, 'c2', 1);",
    );
    undo::step(&mut database, None, |connection| delete_row(connection, "parent", 1)).unwrap();
    assert!(names(&database, "child").is_empty());

    undo::undo(&mut database).unwrap();
    assert_eq!(names(&database, "parent"), vec!["p"]);
    assert_eq!(names(&database, "child"), vec!["c1", "c2"]);
}

#[test]
fn undo_takes_back_a_query_that_changed_every_row() {
    let mut database = memory();
    contacts(&database);
    for name in ["a", "b", "c"] {
        add(&mut database, name);
    }
    undo::step(&mut database, Some("DELETE FROM contacts"), |connection| {
        db::run(connection, "DELETE FROM contacts", &[])
    })
    .unwrap();
    assert!(names(&database, "contacts").is_empty());

    undo::undo(&mut database).unwrap();
    assert_eq!(names(&database, "contacts"), vec!["a", "b", "c"]);
}

#[test]
fn undo_takes_back_a_created_table() {
    let mut database = memory();
    schema(&mut database, "CREATE TABLE fresh (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO fresh (name) VALUES ('x');");
    assert_eq!(list_tables(&database.connection).unwrap().len(), 1);

    undo::undo(&mut database).unwrap();
    assert_eq!(list_tables(&database.connection).unwrap().len(), 0);
}

#[test]
fn undo_brings_back_a_dropped_table_with_its_rows_index_and_trigger() {
    let mut database = memory();
    contacts(&database);
    database
        .connection
        .execute_batch(
            "CREATE INDEX by_name ON contacts(name);
             CREATE TABLE log (what TEXT);
             CREATE TRIGGER noted AFTER INSERT ON contacts BEGIN INSERT INTO log VALUES (new.name); END;",
        )
        .unwrap();
    add(&mut database, "first");
    add(&mut database, "second");

    schema(&mut database, "DROP TABLE \"contacts\";");
    assert_eq!(list_tables(&database.connection).unwrap().len(), 1);

    undo::undo(&mut database).unwrap();
    assert_eq!(names(&database, "contacts"), vec!["first", "second"]);
    let objects: i64 = database
        .connection
        .query_row("SELECT count(*) FROM sqlite_schema WHERE name IN ('by_name', 'noted')", [], |row| row.get(0))
        .unwrap();
    assert_eq!(objects, 2);
    let ids: Vec<i64> = {
        let mut statement = database.connection.prepare("SELECT id FROM contacts ORDER BY id").unwrap();
        let rows = statement.query_map([], |row| row.get(0)).unwrap();
        rows.map(Result::unwrap).collect()
    };
    assert_eq!(ids, vec![1, 2]);
}

#[test]
fn undo_takes_back_an_added_column() {
    let mut database = memory();
    contacts(&database);
    add(&mut database, "Ada");
    schema(&mut database, "ALTER TABLE contacts ADD COLUMN age INTEGER; UPDATE contacts SET age = 36;");

    undo::undo(&mut database).unwrap();
    let columns: i64 = database
        .connection
        .query_row("SELECT count(*) FROM pragma_table_info('contacts')", [], |row| row.get(0))
        .unwrap();
    assert_eq!(columns, 3);
    assert_eq!(names(&database, "contacts"), vec!["Ada"]);
}

#[test]
fn undo_follows_a_table_without_a_primary_key() {
    let mut database = memory();
    database.connection.execute_batch("CREATE TABLE loose (name TEXT);").unwrap();
    undo::step(&mut database, None, |connection| {
        insert_row(connection, "loose", &values(&[("name", serde_json::json!("x"))]))
    })
    .unwrap();

    undo::undo(&mut database).unwrap();
    assert!(names(&database, "loose").is_empty());
}

#[test]
fn a_change_that_fails_leaves_nothing_behind_and_nothing_to_undo() {
    let mut database = memory();
    contacts(&database);
    let failed = undo::step(&mut database, None, |connection| {
        insert_row(connection, "contacts", &values(&[("note", serde_json::json!("no name"))]))
    });
    assert!(failed.is_err());
    assert!(names(&database, "contacts").is_empty());
    assert!(!undo::undo(&mut database).unwrap());
}

#[test]
fn every_change_is_on_disk_at_once() {
    let dir = std::env::temp_dir().join(format!("grt-tables-durable-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("durable.sqlite");
    let _ = fs::remove_file(&path);

    let mut database = Database::create(Some(&path)).unwrap();
    contacts(&database);
    add(&mut database, "written");

    let other = rusqlite::Connection::open(&path).unwrap();
    let count: i64 = other.query_row("SELECT count(*) FROM contacts", [], |row| row.get(0)).unwrap();
    assert_eq!(count, 1);

    drop(other);
    drop(database);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn undo_reaches_back_a_hundred_changes_and_no_further() {
    let mut database = memory();
    contacts(&database);
    for i in 0..105 {
        add(&mut database, &format!("n{i}"));
    }
    let mut undone = 0;
    while undo::undo(&mut database).unwrap() {
        undone += 1;
    }
    assert_eq!(undone, 100);
    assert_eq!(names(&database, "contacts").len(), 5);
}

#[test]
fn the_statement_names_what_it_drops_or_alters() {
    let found = undo::dropped_or_altered(
        "drop table if exists main.\"Old \"\"one\"\"\"; ALTER TABLE [Two] ADD x; -- drop table nope
         SELECT 'drop table quoted'; /* alter table hidden */ DROP TABLE three",
    );
    let mut found: Vec<_> = found.into_iter().collect();
    found.sort();
    assert_eq!(found, vec!["old \"one\"", "three", "two"]);
}

// A file from elsewhere.

#[test]
fn an_opened_database_is_read_only_until_it_is_unlocked() {
    let dir = std::env::temp_dir().join(format!("grt-tables-test-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("foreign.sqlite");
    let _ = fs::remove_file(&path);

    {
        let made = Database::create(Some(&path)).unwrap();
        contacts(&made);
    }

    let mut opened = Database::open(&path).unwrap();
    assert!(opened.read_only);
    assert!(opened.refuse_if_read_only().is_err());
    assert!(undo::step(&mut opened, None, |_| Ok(())).is_err());

    opened.read_only = false;
    assert!(opened.refuse_if_read_only().is_ok());

    drop(opened);
    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir(&dir);
}

#[test]
fn a_created_database_is_writable_at_once() {
    let database = memory();
    assert!(!database.read_only);
    assert!(database.refuse_if_read_only().is_ok());
}

// No journal files left behind.

#[test]
fn a_clean_close_leaves_no_wal_or_shm() {
    let dir = std::env::temp_dir().join(format!("grt-tables-wal-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("work.sqlite");
    let _ = fs::remove_file(&path);

    {
        let database = Database::create(Some(&path)).unwrap();
        contacts(&database);
        insert_row(
            &database.connection,
            "contacts",
            &values(&[("name", serde_json::json!("someone"))]),
        )
        .unwrap();
    }

    db::remove_side_files(&path);

    for suffix in ["-wal", "-shm", "-journal"] {
        let mut beside = path.as_os_str().to_os_string();
        beside.push(suffix);
        assert!(
            !std::path::Path::new(&beside).exists(),
            "{beside:?} should not be there"
        );
    }

    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir(&dir);
}

// VACUUM really removes a deleted row.

#[test]
fn after_vacuum_a_deleted_record_is_gone_from_the_bytes() {
    let dir = std::env::temp_dir().join(format!("grt-tables-vac-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("secrets.sqlite");
    let _ = fs::remove_file(&path);

    let secret = "MEMORABLE-SECRET-STRING-9F3A";

    {
        let database = Database::create(Some(&path)).unwrap();
        contacts(&database);
        for i in 0..200 {
            insert_row(
                &database.connection,
                "contacts",
                &values(&[("name", serde_json::json!(format!("filler {i}")))]),
            )
            .unwrap();
        }
        let rowid = insert_row(
            &database.connection,
            "contacts",
            &values(&[("name", serde_json::json!(secret))]),
        )
        .unwrap();

        // CANARY: while it is there, it is findable in the file.
        let bytes = fs::read(&path).unwrap();
        assert!(
            contains(&bytes, secret.as_bytes()),
            "the search must be able to find it, or the assertion below proves nothing"
        );

        delete_row(&database.connection, "contacts", rowid).unwrap();
        db::vacuum(&database.connection).unwrap();
    }

    let bytes = fs::read(&path).unwrap();
    assert!(
        !contains(&bytes, secret.as_bytes()),
        "a deleted record is still in the file after VACUUM"
    );

    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir(&dir);
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

// What a statement is.

#[test]
fn a_statement_is_recognised_as_reading_or_writing() {
    assert!(!is_write("SELECT * FROM t"));
    assert!(!is_write("  with x as (select 1) select * from x"));
    assert!(is_write("DELETE FROM t"));
    assert!(is_write("UPDATE t SET a = 1"));
    assert!(is_write("CREATE TABLE t (a)"));
}

#[test]
fn a_statement_that_would_change_everything_is_flagged() {
    assert!(is_unbounded_write("DELETE FROM t"));
    assert!(is_unbounded_write("DROP TABLE t"));
    assert!(!is_unbounded_write("DELETE FROM t WHERE id = 1"));
    assert!(!is_unbounded_write("SELECT * FROM t"));
}

// Schema reading.

#[test]
fn a_table_describes_itself() {
    let database = memory();
    database
        .connection
        .execute_batch(
            "CREATE TABLE book (
                 id INTEGER PRIMARY KEY,
                 title TEXT NOT NULL,
                 author_id INTEGER REFERENCES author(id) ON DELETE CASCADE
             );
             CREATE TABLE author (id INTEGER PRIMARY KEY, name TEXT);
             CREATE INDEX book_title ON book(title);",
        )
        .unwrap();

    let described = describe_table(&database.connection, "book").unwrap();

    let columns = described["columns"].as_array().unwrap();
    assert_eq!(columns.len(), 3);
    assert_eq!(columns[1]["name"], serde_json::json!("title"));
    assert_eq!(columns[1]["notNull"], serde_json::json!(true));
    assert_eq!(columns[0]["primaryKey"], serde_json::json!(true));

    let keys = described["foreignKeys"].as_array().unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["table"], serde_json::json!("author"));
    assert_eq!(keys[0]["onDelete"], serde_json::json!("CASCADE"));

    assert!(described["sql"].as_str().unwrap().contains("CREATE TABLE"));
}

#[test]
fn sqlite_bookkeeping_tables_are_not_offered_for_editing() {
    let database = memory();
    database
        .connection
        .execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT);")
        .unwrap();
    database
        .connection
        .execute_batch("INSERT INTO t DEFAULT VALUES;")
        .unwrap();

    let names: Vec<String> = list_tables(&database.connection)
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap().to_string())
        .collect();

    assert!(names.contains(&"t".to_string()));
    assert!(!names.iter().any(|name| name.starts_with("sqlite_")));
}

// Two exports are byte-identical.

#[test]
fn two_exports_of_the_same_database_are_identical() {
    let database = memory();
    database
        .connection
        .execute_batch(
            "CREATE TABLE zebra (id INTEGER PRIMARY KEY, v TEXT);
             CREATE TABLE alpha (id INTEGER PRIMARY KEY, v TEXT);",
        )
        .unwrap();
    for table in ["zebra", "alpha"] {
        for value in ["one", "two'with quote", "three"] {
            insert_row(
                &database.connection,
                table,
                &values(&[("v", serde_json::json!(value))]),
            )
            .unwrap();
        }
    }

    let once = export::parts_of(&database.connection).unwrap();
    let twice = export::parts_of(&database.connection).unwrap();
    assert_eq!(once, twice);
}

#[test]
fn an_export_names_its_tables_alphabetically() {
    let database = memory();
    database
        .connection
        .execute_batch(
            "CREATE TABLE zebra (id INTEGER PRIMARY KEY);
             CREATE TABLE alpha (id INTEGER PRIMARY KEY);",
        )
        .unwrap();

    let parts = export::parts_of(&database.connection).unwrap();
    let schema = &parts.iter().find(|(name, _)| name == export::SCHEMA).unwrap().1;

    let alpha = schema.find("alpha").unwrap();
    let zebra = schema.find("zebra").unwrap();
    assert!(alpha < zebra, "tables should come out in alphabetical order");
}

#[test]
fn an_export_is_readable_text() {
    let database = memory();
    contacts(&database);
    insert_row(
        &database.connection,
        "contacts",
        &values(&[("name", serde_json::json!("Ada Lovelace"))]),
    )
    .unwrap();

    let parts = export::parts_of(&database.connection).unwrap();
    let data = &parts.iter().find(|(name, _)| name == export::DATA).unwrap().1;

    assert!(data.contains("INSERT INTO \"contacts\""));
    assert!(data.contains("'Ada Lovelace'"));
}

#[test]
fn an_export_escapes_quotes_rather_than_breaking() {
    let database = memory();
    contacts(&database);
    insert_row(
        &database.connection,
        "contacts",
        &values(&[("name", serde_json::json!("O'Brien"))]),
    )
    .unwrap();

    let parts = export::parts_of(&database.connection).unwrap();
    let data = parts.iter().find(|(name, _)| name == export::DATA).unwrap().1.clone();
    assert!(data.contains("'O''Brien'"));

    // And it can be read back in.
    let restored = memory();
    let schema = parts.iter().find(|(name, _)| name == export::SCHEMA).unwrap().1.clone();
    export::restore(&restored.connection, &schema, &data).unwrap();

    let back: String = restored
        .connection
        .query_row("SELECT name FROM contacts", [], |row| row.get(0))
        .unwrap();
    assert_eq!(back, "O'Brien");
}

#[test]
fn an_archive_round_trips_a_whole_database() {
    let database = memory();
    database
        .connection
        .execute_batch(
            "CREATE TABLE author (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
             CREATE TABLE book (id INTEGER PRIMARY KEY, title TEXT,
                 author_id INTEGER REFERENCES author(id));
             CREATE INDEX book_title ON book(title);",
        )
        .unwrap();

    insert_row(
        &database.connection,
        "author",
        &values(&[("name", serde_json::json!("Ada"))]),
    )
    .unwrap();
    insert_row(
        &database.connection,
        "book",
        &values(&[
            ("title", serde_json::json!("Notes")),
            ("author_id", serde_json::json!(1)),
        ]),
    )
    .unwrap();

    let parts = export::parts_of(&database.connection).unwrap();
    let schema = parts.iter().find(|(n, _)| n == export::SCHEMA).unwrap().1.clone();
    let data = parts.iter().find(|(n, _)| n == export::DATA).unwrap().1.clone();

    let restored = memory();
    export::restore(&restored.connection, &schema, &data).unwrap();

    assert_eq!(list_tables(&restored.connection).unwrap().len(), 2);

    let title: String = restored
        .connection
        .query_row("SELECT title FROM book", [], |row| row.get(0))
        .unwrap();
    assert_eq!(title, "Notes");

    // The export of the restored database matches the original's.
    assert_eq!(export::parts_of(&restored.connection).unwrap(), parts);
}

#[test]
fn an_export_carries_no_timestamp_and_no_user() {
    let database = memory();
    contacts(&database);

    let parts = export::parts_of(&database.connection).unwrap();
    let all = parts
        .iter()
        .map(|(_, text)| text.as_str())
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();

    for leak in ["created", "modified", "author:", "user", "\\home\\", "/home/"] {
        assert!(!all.contains(leak), "the export mentions {leak}");
    }
}
