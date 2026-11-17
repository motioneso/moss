//! The Pantry and Staples tools. Reading never writes. Every edit then asks the shopping list
//! to follow, so lines the Pantry now covers show as covered.
use crate::input::{self, invalid, Checked, Fields};
use crate::list::ingredient_key;
use crate::shopping::{
    on_pantry_change, read_pantry, read_quantity, read_unit, PANTRY_ITEMS, STAPLES, UNDO,
};
use crate::store::{find, insert_ignore, num, select, text, update};
use crate::util::{jopt, new_id, values};
use crate::kitchen;
use moss_module_sdk::{
    query::{Filter, Query},
    Client, Host, Result,
};
use serde_json::{json, Value};

const NO_ITEM: &str = "There is no Pantry item with that id";
const NO_STAPLE: &str = "There is no Staple with that id";
const QUANTITY: &str = "quantity must be a number above 0, or null for no amount";

fn view<H: Host + ?Sized>(host: &H) -> Result<Value> {
    let (items, staples) = read_pantry(host)?;
    Ok(json!({
        "items": items.iter().map(|i| json!({
            "itemId": i["item_id"],
            "name": i["name"],
            "quantity": jopt(num(&i["quantity"])),
            "unit": i["unit"],
            "source": i["source"],
            "updatedAt": i["updated_at"],
        })).collect::<Vec<_>>(),
        "staples": staples.iter().map(|s| json!({"stapleId": s["staple_id"], "name": s["name"]})).collect::<Vec<_>>(),
    }))
}

pub fn get<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    if let Err(e) = input::no_unknown_keys(input, &[]) {
        return Ok(Err(e));
    }
    Ok(Ok(view(host)?))
}

fn by_id<'a>(key: &'a str, id: &'a str) -> Filter {
    Filter::eq(key, id)
}

fn edit_item<H: Host + ?Sized>(host: &H, action: &str, input: &Fields) -> Result<Checked<Value>> {
    if action == "add" {
        let parsed = (|| {
            let name = input::text(input, "name", true, 80)?.unwrap_or_default();
            let quantity = read_quantity(input, "quantity", QUANTITY)?.flatten();
            let unit = read_unit(input, "unit")?.flatten();
            Ok((name, quantity, unit))
        })();
        let (name, quantity, unit) = match parsed {
            Ok(p) => p,
            Err(e) => return Ok(Err(e)),
        };
        let kitchen_id = kitchen::ensure(host)?;
        Client(host).query(
            PANTRY_ITEMS,
            &Query::insert(values(vec![
                ("kitchen_id", json!(kitchen_id)),
                ("item_id", json!(new_id(host)?)),
                ("name", json!(name)),
                ("name_key", json!(ingredient_key(&name))),
                ("quantity", jopt(quantity)),
                ("unit", json!(unit)),
                ("source", json!("manual")),
            ])),
        )?;
        return Ok(Ok(Value::Null));
    }
    let item_id = match input::uuid(input, "itemId", true) {
        Ok(id) => id.unwrap_or_default(),
        Err(e) => return Ok(Err(e)),
    };
    if action == "update" {
        let parsed = (|| {
            let name = input::text(input, "name", false, 80)?;
            let quantity = read_quantity(input, "quantity", QUANTITY)?;
            let unit = read_unit(input, "unit")?;
            Ok((name, quantity, unit))
        })();
        let (name, quantity, unit) = match parsed {
            Ok(p) => p,
            Err(e) => return Ok(Err(e)),
        };
        let mut set: Vec<(&str, Value)> = vec![];
        if let Some(name) = name {
            set.push(("name_key", json!(ingredient_key(&name))));
            set.push(("name", json!(name)));
        }
        if let Some(q) = quantity {
            set.push(("quantity", jopt(q)));
        }
        if let Some(u) = unit {
            set.push(("unit", json!(u)));
        }
        if !update(host, PANTRY_ITEMS, by_id("item_id", &item_id), set)? {
            return Ok(invalid(NO_ITEM));
        }
        return Ok(Ok(Value::Null));
    }
    let Some(row) = find(host, PANTRY_ITEMS, by_id("item_id", &item_id))? else {
        return Ok(invalid(NO_ITEM));
    };
    let kitchen_id = kitchen::view(host)?["kitchenId"].as_str().unwrap_or_default().to_owned();
    let action_id = new_id(host)?;
    let record = json!({
        "item_id": row["item_id"], "name": row["name"], "name_key": row["name_key"],
        "quantity": jopt(num(&row["quantity"])), "unit": row["unit"],
        "source": row["source"], "created_at": row["created_at"],
    });
    // The undo record is saved first, so a crash between the writes loses nothing.
    insert_ignore(
        host,
        UNDO,
        vec![
            ("kitchen_id", json!(kitchen_id)),
            ("action_id", json!(action_id)),
            ("kind", json!("removed")),
            ("before_state", json!({"item": record})),
        ],
    )?;
    if Client(host).query(PANTRY_ITEMS, &Query::delete(by_id("item_id", &item_id)))?.is_empty() {
        return Ok(invalid(NO_ITEM));
    }
    Ok(Ok(json!({"actionId": action_id, "kind": "removed", "count": 1})))
}

fn edit_staple<H: Host + ?Sized>(host: &H, action: &str, input: &Fields) -> Result<Checked<Value>> {
    if action == "add" {
        let name = match input::text(input, "name", true, 80) {
            Ok(n) => n.unwrap_or_default(),
            Err(e) => return Ok(Err(e)),
        };
        let kitchen_id = kitchen::ensure(host)?;
        // A Staple already on the list is not an error; the result shows it once.
        insert_ignore(
            host,
            STAPLES,
            vec![
                ("kitchen_id", json!(kitchen_id)),
                ("staple_id", json!(new_id(host)?)),
                ("name", json!(name)),
                ("name_key", json!(ingredient_key(&name))),
            ],
        )?;
        return Ok(Ok(Value::Null));
    }
    let staple_id = match input::uuid(input, "stapleId", true) {
        Ok(id) => id.unwrap_or_default(),
        Err(e) => return Ok(Err(e)),
    };
    if action == "update" {
        let name = match input::text(input, "name", true, 80) {
            Ok(n) => n.unwrap_or_default(),
            Err(e) => return Ok(Err(e)),
        };
        let key = ingredient_key(&name);
        if find(host, STAPLES, by_id("staple_id", &staple_id))?.is_none() {
            return Ok(invalid(NO_STAPLE));
        }
        let taken = select(host, STAPLES, Query::select(Filter::eq("name_key", key.as_str())))?
            .iter()
            .any(|s| text(s, "staple_id") != staple_id);
        if taken {
            return Ok(invalid("That Staple is already on the list"));
        }
        // Staples carry no updated_at column, so this skips the shared update helper.
        let changed = Client(host).query(
            STAPLES,
            &Query::update(by_id("staple_id", &staple_id), values(vec![("name", json!(name)), ("name_key", json!(key))])),
        )?;
        return Ok(if changed.is_empty() { invalid(NO_STAPLE) } else { Ok(Value::Null) });
    }
    let gone = Client(host).query(STAPLES, &Query::delete(by_id("staple_id", &staple_id)))?;
    Ok(if gone.is_empty() { invalid(NO_STAPLE) } else { Ok(Value::Null) })
}

pub fn edit<H: Host + ?Sized>(host: &H, input: &Fields) -> Result<Checked<Value>> {
    let parsed = (|| {
        input::no_unknown_keys(input, &["action", "target", "itemId", "stapleId", "name", "quantity", "unit"])?;
        let action = input::required_choice(input, "action", &["add", "update", "remove"])?;
        let target = input::choice(input, "target", &["item", "staple"])?.unwrap_or_else(|| "item".into());
        Ok((action, target))
    })();
    let (action, target) = match parsed {
        Ok(p) => p,
        Err(e) => return Ok(Err(e)),
    };
    let result = if target == "item" { edit_item(host, &action, input)? } else { edit_staple(host, &action, input)? };
    let undo = match result {
        Ok(undo) => undo,
        Err(e) => return Ok(Err(e)),
    };
    on_pantry_change(host)?;
    Ok(Ok(json!({"pantry": view(host)?, "undo": undo})))
}
