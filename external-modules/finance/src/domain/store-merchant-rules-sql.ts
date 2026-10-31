import type { MerchantRuleStore, MerchantRule } from "./merchant-rules.js";
import type { FinanceDb } from "./store-sql.js";
export function merchantRuleSqlStore(db: FinanceDb): MerchantRuleStore {
  return {
    async all() {
      const result = await db.query<{ rules: MerchantRule[] }>(
        `SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'payeeKey',payee_key,'categoryId',category_id,
          'enabled',enabled,'createdAt',created_at,'updatedAt',updated_at,
          'writeRevision',md5(id || ':' || xmin::text)) ORDER BY payee_key,id),'[]'::jsonb) AS rules
         FROM app.finance_merchant_rules`
      );
      return result.rows[0]?.rules ?? [];
    },
    async importLegacy(rules) {
      // Rules whose category is gone are skipped, and a rule already stored wins.
      await db.query(
        `INSERT INTO app.finance_merchant_rules(owner_user_id,id,payee_key,category_id,enabled,created_at,updated_at)
         SELECT app.current_actor_user_id(),r.id,r."payeeKey",r."categoryId",true,r."createdAt",r."createdAt"
         FROM jsonb_to_recordset($1::jsonb) AS r(id text,"payeeKey" text,"categoryId" text,"createdAt" timestamptz)
         WHERE EXISTS(SELECT 1 FROM app.finance_categories c WHERE c.id=r."categoryId")
         ON CONFLICT DO NOTHING`,
        [JSON.stringify(rules)]
      );
    },
    async apply(c) {
      const result = await db.query<{ applied: boolean }>(
        `WITH previous AS MATERIALIZED (
          SELECT *,md5(id || ':' || xmin::text) AS revision FROM app.finance_merchant_rules WHERE id=$1 FOR UPDATE
        ), destination AS MATERIALIZED (
          SELECT id FROM app.finance_categories WHERE id=$3 AND (archived_at IS NULL OR
            (NOT $4::boolean AND EXISTS(SELECT 1 FROM previous WHERE category_id=$3))) ORDER BY id FOR SHARE
        ), eligible AS (
          SELECT 1 WHERE EXISTS(SELECT 1 FROM destination) AND (
            ($5::text IS NULL AND NOT EXISTS(SELECT 1 FROM previous)) OR
            EXISTS(SELECT 1 FROM previous WHERE revision=$5 AND payee_key=$2))
        ), saved AS (
          INSERT INTO app.finance_merchant_rules(owner_user_id,id,payee_key,category_id,enabled,created_at,updated_at)
          SELECT app.current_actor_user_id(),$1,$2,$3,$4::boolean,$6::timestamptz,$6::timestamptz FROM eligible
          ON CONFLICT(owner_user_id,id) DO UPDATE SET category_id=excluded.category_id,enabled=excluded.enabled,updated_at=excluded.updated_at
          WHERE $5::text IS NOT NULL AND md5(finance_merchant_rules.id || ':' || finance_merchant_rules.xmin::text)=$5
            AND finance_merchant_rules.payee_key=excluded.payee_key RETURNING id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params,undo)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$6::timestamptz,$7,'merchant-rule.set',
            jsonb_build_object('ruleId',$1::text,'categoryId',$3::text,'enabled',CASE WHEN $4::boolean THEN 1 ELSE 0 END,
              'previousCategoryId',(SELECT category_id FROM previous)),
            jsonb_build_object('ruleId',$1::text,'categoryId',(SELECT category_id FROM previous),
              'enabled',CASE WHEN coalesce((SELECT enabled FROM previous),false) THEN 1 ELSE 0 END)
          FROM saved RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM saved) AS applied`,
        [c.id, c.payeeKey, c.categoryId, c.enabled, c.expectedRevision, c.at, c.actor]
      );
      return result.rows[0]?.applied === true;
    },
    async undo(activityId, writeRevision, at) {
      const result = await db.query<{ applied: boolean }>(
        `WITH activity AS MATERIALIZED (
          SELECT * FROM app.finance_activity WHERE id=$1::uuid AND kind='merchant-rule.set'
            AND undone_at IS NULL AND undo IS NOT NULL FOR UPDATE
        ), current_rule AS MATERIALIZED (
          SELECT r.* FROM app.finance_merchant_rules r JOIN activity a ON r.id=a.params->>'ruleId'
          WHERE md5(r.id || ':' || r.xmin::text)=$2 AND r.category_id=a.params->>'categoryId'
            AND r.enabled=(coalesce(a.params->>'enabled','1')='1') ORDER BY r.id FOR UPDATE OF r
        ), restore AS MATERIALIZED (
          SELECT r.id,coalesce(a.undo->>'categoryId',r.category_id) AS category_id,
            (a.undo->>'categoryId' IS NOT NULL AND coalesce(a.undo->>'enabled','1')='1') AS enabled
          FROM activity a CROSS JOIN current_rule r
        ), destination AS MATERIALIZED (
          SELECT c.id FROM app.finance_categories c JOIN restore r ON c.id=r.category_id
            WHERE NOT r.enabled OR c.archived_at IS NULL ORDER BY c.id FOR SHARE OF c
        ), saved AS (
          UPDATE app.finance_merchant_rules r SET category_id=s.category_id,enabled=s.enabled,updated_at=$3::timestamptz
          FROM restore s WHERE r.id=s.id AND EXISTS(SELECT 1 FROM destination) RETURNING r.id
        ), reversal AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$3::timestamptz,'user','merchant-rule.set',
            jsonb_build_object('ruleId',s.id,'categoryId',s.category_id,'enabled',CASE WHEN s.enabled THEN 1 ELSE 0 END)
          FROM restore s JOIN saved r ON r.id=s.id RETURNING id
        ), marked AS (
          UPDATE app.finance_activity SET undone_at=$3::timestamptz WHERE id=$1::uuid
            AND EXISTS(SELECT 1 FROM reversal) RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM marked) AS applied`,
        [activityId, writeRevision, at]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
