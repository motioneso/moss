//! Part 9 uses the installed packages and the same assertions with RLS removed and restored.
use anyhow::{ensure, Result};
use reqwest::{blocking::Client, Method};
use serde_json::{json, Value};
use tokio::runtime::Runtime;
use uuid::Uuid;

pub fn check(
    client: &Client,
    origin: &str,
    cookie: &str,
    runtime: &Runtime,
    bootstrap: &str,
    owner: Uuid,
    own_task: Uuid,
    foreign_task: Uuid,
) {
    let read = |day: &str| {
        let response = client
            .get(format!(
                "{origin}/api/m/calendar/day-plan?date={day}&timeZone=UTC"
            ))
            .header("origin", origin)
            .header("cookie", cookie)
            .send()
            .unwrap();
        assert_eq!(response.status(), 200);
        response.json::<Value>().unwrap()
    };
    let (db, foreign_plan) = runtime.block_on(async {
        let (db, connection) = tokio_postgres::connect(bootstrap, tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move { let _ = connection.await; });
        let foreign: Uuid = db.query_one("SELECT owner_user_id FROM app.tasks WHERE id=$1", &[&foreign_task]).await.unwrap().get(0);
        let foreign_plan = Uuid::new_v4();
        db.execute("INSERT INTO app.day_plans(id,owner_user_id,local_day,time_zone) VALUES($1,$2,'2030-05-25','UTC')", &[&foreign_plan,&foreign]).await.unwrap();
        (db, foreign_plan)
    });
    let private_plan = || -> Result<()> {
        ensure!(
            read("2030-05-25")["plan"].is_null(),
            "another account's plan appeared"
        );
        Ok(())
    };
    private_plan().unwrap();
    runtime
        .block_on(db.batch_execute("ALTER TABLE app.day_plans DISABLE ROW LEVEL SECURITY"))
        .unwrap();
    let red = private_plan();
    runtime.block_on(db.batch_execute("ALTER TABLE app.day_plans ENABLE ROW LEVEL SECURITY; ALTER TABLE app.day_plans FORCE ROW LEVEL SECURITY")).unwrap();
    assert_eq!(
        red.unwrap_err().to_string(),
        "another account's plan appeared"
    );
    println!("RED Part 9 plan ownership: same assertion failed with day_plans RLS removed");
    private_plan().unwrap();
    println!("GREEN Part 9 plan ownership: same assertion passed with RLS restored");

    let response = client
        .request(Method::POST, format!("{origin}/api/m/calendar/day-plans"))
        .header("origin", origin)
        .header("cookie", cookie)
        .json(&json!({"date":"2030-05-26","timeZone":"UTC"}))
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    let plan: Value = response.json().unwrap();
    let plan = Uuid::parse_str(plan["plan"]["id"].as_str().unwrap()).unwrap();
    // Legacy saved soft references can outlive visibility. Setup writes only this disposable DB.
    runtime.block_on(async {
        for (task, position) in [(own_task,0_i32),(foreign_task,1)] {
            db.execute("INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,task_id,title,position) VALUES($1,$2,$3,'focus',$4,'Saved task label',$5)", &[&Uuid::new_v4(),&plan,&owner,&task,&position]).await.unwrap();
        }
    });
    let visible = read("2030-05-26");
    assert!(
        visible["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|task| task["id"] == own_task.to_string()),
        "the real Tasks projection must resolve the caller's task: {visible}"
    );
    let unavailable = || -> Result<()> {
        let body = read("2030-05-26");
        ensure!(
            body["unavailableTaskIds"] == json!([foreign_task]),
            "hidden task was not listed as unavailable"
        );
        ensure!(
            !body["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .any(|task| task["id"] == foreign_task.to_string()),
            "hidden task summary appeared"
        );
        Ok(())
    };
    unavailable().unwrap();
    runtime
        .block_on(db.batch_execute("ALTER TABLE app.tasks DISABLE ROW LEVEL SECURITY"))
        .unwrap();
    let red = unavailable();
    runtime.block_on(db.batch_execute("ALTER TABLE app.tasks ENABLE ROW LEVEL SECURITY; ALTER TABLE app.tasks FORCE ROW LEVEL SECURITY")).unwrap();
    assert_eq!(
        red.unwrap_err().to_string(),
        "hidden task was not listed as unavailable"
    );
    println!("RED Part 9 unavailable task: same assertion failed with Tasks RLS removed");
    unavailable().unwrap();
    println!("GREEN Part 9 unavailable task: same assertion passed with Tasks RLS restored");
    runtime
        .block_on(db.execute(
            "DELETE FROM app.day_plans WHERE id=ANY($1)",
            &[&vec![plan, foreign_plan]],
        ))
        .unwrap();
}

/// Demo records, not intercepted responses: the installed GET resolves these stored references.
pub fn seed(
    client: &Client,
    origin: &str,
    cookie: &str,
    runtime: &Runtime,
    bootstrap: &str,
    owner: Uuid,
    own_task: Uuid,
    foreign_task: Uuid,
) {
    let response = client
        .get(format!("{origin}/api/m/calendar/display-settings"))
        .header("origin", origin)
        .header("cookie", cookie)
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    let display: Value = response.json().unwrap();
    let zone = display["timezone"].as_str().unwrap();
    let (day, other)=runtime.block_on(async {
        let (db, connection)=tokio_postgres::connect(bootstrap,tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {let _=connection.await;});
        let day: String=db.query_one("SELECT (now() AT TIME ZONE $1)::date::text",&[&zone]).await.unwrap().get(0);
        db.execute("UPDATE app.tasks SET title='Prepare the workshop outline' WHERE id=$1",&[&own_task]).await.unwrap();
        let list: Uuid=db.query_one("SELECT list_id FROM app.tasks WHERE id=$1",&[&own_task]).await.unwrap().get(0);
        let other=Uuid::new_v4();
        db.execute("INSERT INTO app.tasks(id,owner_user_id,list_id,title,status) VALUES($1,$2,$3,'Review the launch checklist','todo')",&[&other,&owner,&list]).await.unwrap();
        (day,other)
    });
    let response = client
        .post(format!("{origin}/api/m/calendar/day-plans"))
        .header("origin", origin)
        .header("cookie", cookie)
        .json(&json!({"date":day,"timeZone":zone}))
        .send()
        .unwrap();
    assert_eq!(response.status(), 200);
    let saved: Value = response.json().unwrap();
    let plan = Uuid::parse_str(saved["plan"]["id"].as_str().unwrap()).unwrap();
    runtime.block_on(async {
        let (db,connection)=tokio_postgres::connect(bootstrap,tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {let _=connection.await;});
        for (task,position,hour,title) in [(own_task,0_i32,"10:00:00","Prepare the workshop outline"),(other,1,"12:00:00","Review the launch checklist"),(foreign_task,2,"14:00:00","Saved unavailable task")] {
            let at=format!("{day} {hour}");
            let time: String=db.query_one("SELECT to_char($1::text::timestamp AT TIME ZONE $2 AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')",&[&at,&zone]).await.unwrap().get(0);
            let placement=json!({"startsAt":time,"durationMinutes":if position==0 {45} else {30},"calendarEventRef":null});
            let (actual,pending)=if position==1 {(placement,Value::Null)} else {(Value::Null,json!({"kind":"add","startsAt":time,"durationMinutes":45}))};
            db.execute("INSERT INTO app.day_plan_blocks(id,plan_id,owner_user_id,kind,task_id,title,position,actual_placement,pending_change) VALUES($1,$2,$3,'focus',$4,$5,$6,$7,$8)",&[&Uuid::new_v4(),&plan,&owner,&task,&title,&position,&actual,&pending]).await.unwrap();
        }
    });
}
