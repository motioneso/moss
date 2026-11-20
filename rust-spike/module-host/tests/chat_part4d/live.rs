//! Disposable saved email for the live card proof. No provider credentials; reject the card.
use serde_json::{json, Value};
use tokio_postgres::Client;
use uuid::Uuid;

pub async fn seed(db: &Client, owner: Uuid) -> Value {
    let account = Uuid::new_v4();
    let message = Uuid::new_v4();
    db.execute("INSERT INTO app.connector_accounts(id,provider_id,owner_user_id,scopes,status,encrypted_secret) VALUES($1,'google',$2,ARRAY['https://www.googleapis.com/auth/gmail.modify'],'active','{}')", &[&account,&owner]).await.unwrap();
    db.execute("INSERT INTO app.email_messages(id,connector_account_id,owner_user_id,sender,subject,received_at,external_id,external_metadata) VALUES($1,$2,$3,'Alex Example <alex@example.test>','Part 4d planning check',now(),'js389-proof','{\"threadId\":\"js389-thread\",\"messageId\":\"js389@example.test\"}')", &[&message,&account,&owner]).await.unwrap();
    json!({"cacheMessageId":message,"recipient":"Alex Example <alex@example.test>","subject":"Re: Part 4d planning check"})
}
