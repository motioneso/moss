//! Each installed-test world owns its worker jobs as well as its package catalog.
use crate::support::Fixture;
use crate::{segment, upload, World};

pub(super) fn reset(f: &Fixture) {
    let queues: Vec<String> =
        moss_module_host::jobs::specs(&moss_backtrack_host::package::manifest().unwrap())
            .into_iter()
            .map(|spec| spec.name)
            .collect();
    // Worlds share only the gate's disposable database. A previous world's due
    // sweep or index job must not consume the new world's fixed worker ticks,
    // nor run with its replacement host, linked Macs and embedder.
    f.rt.block_on(async {
        f.root
            .execute(
                "DELETE FROM moss_queue.schedules WHERE queue=ANY($1)",
                &[&queues],
            )
            .await
            .unwrap();
        f.root
            .execute(
                "DELETE FROM moss_queue.jobs WHERE queue=ANY($1)",
                &[&queues],
            )
            .await
            .unwrap();
    });
}

#[test]
#[ignore = "Only through verify-gate"]
fn a_new_world_indexes_its_upload_after_a_previous_world_left_work_due() {
    let previous = World::new();
    previous.link(previous.f.a);
    // More old work than run_jobs' six ticks, plus the sweep that becomes due
    // when a long suite crosses minute seven. No wall-clock wait is needed.
    for n in 0..6 {
        let reply = previous.call(
            previous.f.a,
            "POST",
            "/ingest",
            upload(vec![segment(10 + n, &format!("previous {n}"))]),
        );
        assert_eq!(reply["body"]["accepted"], 1);
    }
    assert_eq!(
        previous.count(
            "SELECT count(*) FROM moss_queue.jobs WHERE actor_user_id=$1 AND state='pending'",
            previous.f.a
        ),
        6
    );
    let schedules = previous.f.rt.block_on(previous.f.root.execute("UPDATE moss_queue.schedules SET next_at=now()-interval '1 minute' WHERE actor_user_id=$1 AND queue LIKE '%backtrack.upkeep'", &[&previous.f.a])).unwrap();
    assert_eq!(schedules, 1, "the previous world must leave its sweep due");
    let previous_owner = previous.f.a;
    drop(previous);

    let w = World::new();
    w.link(w.f.a);
    assert_eq!(
        w.call(
            w.f.a,
            "POST",
            "/ingest",
            upload(vec![segment(10, "current")])
        )["body"]["accepted"],
        1
    );
    w.run_jobs();
    assert_eq!(
        (w.unindexed(w.f.a), w.chunks(w.f.a)),
        (0, 1),
        "previous test work must not consume this world's worker ticks"
    );
    assert_eq!(
        w.chunks(previous_owner),
        0,
        "the new world's embedder must not run old actors' jobs"
    );
    assert_eq!(
        w.count(
            "SELECT count(*) FROM moss_queue.schedules WHERE actor_user_id=$1",
            previous_owner
        ),
        0
    );
}
