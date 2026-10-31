# Disposable Finance gate storage recovery

Continuous Finance acceptance filled the environment's Docker storage. The next gate failed
database provisioning before its test executed. Docker reported 236 volumes, with about 25 GB
unused. The wrapper removes its disposable containers with `docker rm -f`, leaving the image's
anonymous PostgreSQL volumes behind.

Use `docker rm -fv` at the existing wrapper cleanup sites. Docker's own CLI documents `-v` as
removing associated anonymous volumes; named volumes remain outside that operation. Do not change
container selection, stale-run detection, database isolation, sentinels or test verdict handling.
Do not prune all volumes or remove production/named/in-use storage.

For the existing leak, Docker event records linked ten unmounted anonymous volumes to this task's
completed Finance gate containers. Each was independently checked for its anonymous label and zero
container references before removal. This recovered 1.5 GB. The persistent named database volume
and current aggregate gate were untouched. Source changes, installed dependencies, screenshots and
receipts were retained. Verify subsequent gate completion removes its observed anonymous volume.
