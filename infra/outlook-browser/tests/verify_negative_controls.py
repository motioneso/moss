"""Mutate copies of the actual modules; never weaken the working-tree sources."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CONTROLS = (
    ('seccomp deny default', 'chromium_seccomp.py',
     "if default.get('defaultAction') != 'SCMP_ACT_ERRNO':", 'if False:',
     'test_chromium_seccomp.ChromiumSeccomp.test_permissive_source_is_rejected'),
    ('address policy', 'egress.py',
     'if not allowed or any(address in network for network in denied_networks):',
     'if False:', 'test_egress.AddressPolicy.test_special_addresses'),
    ('DNS pin', 'egress.py', 'address = addresses[0]', 'address = host',
     'test_egress.UnixTransport.test_dns_pin_and_bidirectional_tunnel'),
    ('revocation tombstone', 'lifecycle.py',
     "row[1] in ('removing', 'removed')", 'False',
     'test_lifecycle.Lifecycle.test_removed_runtime_cannot_be_recreated_after_restart'),
    ('cancellation drain', 'runtime.py', 'result = await asyncio.shield(task)',
     'result = await task',
     'test_runtime.RuntimeComposition.test_cancelled_allocate_cannot_finish_after_cleanup_ack'),
    ('broker peer UID', 'broker.py', 'if uid != self.allowed_uid:', 'if False:',
     'test_broker.LifecycleProtocol.test_peer_uid_denied_before_runtime_access'),
    ('engine supervisor lock', 'engine_command.py', 'os.fstat(lock_descriptor)',
     'os.close(lock_descriptor)',
     'test_service_lock.BrokerDeath.test_orphaned_engine_holds_lock_until_late_creation_finishes'),
    ('private socket directory', 'broker.py',
     'stat.S_IMODE(info.st_mode) != 0o750', 'False',
     'test_broker.LifecycleProtocol.test_unsafe_socket_directory_and_symlink_are_rejected'),
    ('engine descriptor boundary', 'engine_command.py', 'close_fds=True', 'close_fds=False',
     'test_service_lock.BrokerDeath.test_orphaned_engine_holds_lock_until_late_creation_finishes'),
    ('trusted configuration', 'service.py', 'info.st_mode & 0o022', 'False',
     'test_service.TrustedConfiguration.test_config_requires_trusted_file_absolute_paths_and_network_policy'),
    ('parent pidfd binding', 'engine_command.py', 'if os.getppid() != parent_pid:', 'if False:',
     'test_engine_command.EngineTimeout.test_parent_dying_during_pidfd_open_cannot_bind_reused_pid'),
    ('failed allocation egress revocation', 'runtime.py', 'await failed_proxy.revoke()',
     'await asyncio.sleep(0)',
     'test_runtime.RuntimeComposition.test_failed_allocation_revokes_its_egress_before_retry'),
    ('host interface discovery', 'infrastructure.py',
     'interfaces.result(), *(task.result() for task in resolutions)',
     '*(task.result() for task in resolutions)',
     'test_infrastructure.Discovery.test_interfaces_and_every_ingress_answer_are_included'),
    ('public ingress discovery', 'infrastructure.py',
     '*(task.result() for task in resolutions)', '*()',
     'test_infrastructure.Discovery.test_interfaces_and_every_ingress_answer_are_included'),
    ('retired ingress addresses', 'infrastructure.py', 'networks = self.networks | frozenset',
     'networks = frozenset',
     'test_infrastructure.Policy.test_rotating_dns_retains_old_addresses_and_static_networks'),
    ('infrastructure freshness', 'infrastructure.py',
     'if asyncio.get_running_loop().time() >= self.deadline:', 'if False:',
     'test_infrastructure.Policy.test_new_policy_and_expired_policy_are_unavailable'),
    ('failed infrastructure refresh', 'infrastructure.py',
     'except Exception:\n            self.invalidate()', 'except Exception:\n            pass',
     'test_infrastructure.Policy.test_failure_blocks_until_a_complete_refresh_recovers'),
    ('infrastructure expiry timer', 'infrastructure.py',
     'self.expiry = loop.call_at(self.deadline, self.invalidate)', 'self.expiry = None',
     'test_infrastructure.LiveTunnels.test_expiry_timer_closes_existing_tunnel_without_new_request'),
    ('infrastructure tunnel closure', 'infrastructure.py', 'proxy.close_connections()', 'pass',
     'test_infrastructure.LiveTunnels.test_refresh_denies_new_address_and_closes_existing_tunnel'),
    ('dynamic destination denial', 'egress.py', 'self.infrastructure.snapshot(host) if self.infrastructure',
     '(self.infrastructure.snapshot(host)[0], self.denied_networks) if self.infrastructure',
     'test_infrastructure.LiveTunnels.test_refresh_denies_new_address_and_closes_existing_tunnel'),
    ('configured ingress hostname', 'infrastructure.py', 'if host in self.hosts:', 'if False:',
     'test_infrastructure.LiveTunnels.test_configured_hostname_denied_between_dns_refreshes'),
    ('IPv6 infrastructure denial', 'egress.py', 'self.infrastructure.snapshot(host) if self.infrastructure',
     '(self.infrastructure.snapshot(host)[0], self.denied_networks) if self.infrastructure',
     'test_infrastructure.LiveTunnels.test_public_ipv6_ingress_literal_denied_before_dial'),
    ('infrastructure DNS completeness', 'infrastructure.py',
     'if not answers or len(answers) > 64:', 'if False:',
     'test_infrastructure.Discovery.test_partial_or_oversized_dns_failure_never_publishes'),
    ('infrastructure history bound', 'infrastructure.py', 'if len(networks) > 4096:', 'if False:',
     'test_infrastructure.Policy.test_address_history_exhaustion_fails_closed'),
    ('pre-dial policy generation', 'egress.py',
     'if self.infrastructure:\n                    self.infrastructure.check(generation)',
     'if self.infrastructure:\n                    pass',
     'test_infrastructure.LiveTunnels.test_refresh_during_dns_cannot_dial_a_newly_denied_address'),
    ('post-dial policy generation', 'egress.py',
     'if self.infrastructure:\n                self.infrastructure.check(generation)',
     'if self.infrastructure:\n                pass',
     'test_infrastructure.LiveTunnels.test_refresh_during_dial_cannot_acknowledge_stale_connection'),
    ('service policy binding', 'service.py', 'infrastructure=policy', 'infrastructure=None',
     'test_service.ServicePolicy.test_service_binds_discovered_policy_through_runtime_to_proxy'),
    ('runtime policy binding', 'runtime.py', 'infrastructure=self.infrastructure', 'infrastructure=None',
     'test_service.ServicePolicy.test_service_binds_discovered_policy_through_runtime_to_proxy'),
    ('startup discovery', 'service.py', 'if not await policy.refresh():', 'if False:',
     'test_service.ServicePolicy.test_failed_initial_discovery_precedes_engine_and_broker'),
    ('trusted infrastructure host input', 'service.py', "validate_hosts(config['infrastructure_hosts'])",
     'pass',
     'test_service.TrustedConfiguration.test_config_requires_trusted_file_absolute_paths_and_network_policy'),
    ('periodic infrastructure discovery', 'infrastructure.py', 'await self.refresh()', 'pass',
     'test_infrastructure.Policy.test_background_loop_refreshes_and_invalidates_on_exit'),
    ('service refresh scheduling', 'service.py', 'refreshing = asyncio.create_task(policy.run())',
     'refreshing = None',
     'test_service.ServicePolicy.test_service_binds_discovered_policy_through_runtime_to_proxy'),
)


def verify():
    for name, filename, before, after, test in CONTROLS:
        with tempfile.TemporaryDirectory(prefix='moss-runtime-negative-') as directory:
            for module in ('egress.py', 'lifecycle.py', 'runtime.py', 'broker.py',
                           'podman.py', 'service_lock.py', 'engine_command.py', 'service.py',
                           'chromium_seccomp.py', 'infrastructure.py'):
                source = (ROOT / module).read_text()
                if module == filename:
                    if source.count(before) != 1:
                        raise RuntimeError('Negative control source changed: ' + name)
                    source = source.replace(before, after)
                (Path(directory) / module).write_text(source)
            environment = {**os.environ, 'PYTHONPATH': directory + os.pathsep + str(ROOT / 'tests')}
            result = subprocess.run([sys.executable, '-B', '-m', 'unittest', test],
                                    env=environment, capture_output=True, text=True, timeout=10)
            if result.returncode != 1 or 'FAILED (failures=' not in result.stderr:
                raise RuntimeError('Expected assertion failure missing: ' + name)
            print('PASS: removed ' + name + ' guard causes an assertion failure')


if __name__ == '__main__':
    verify()
