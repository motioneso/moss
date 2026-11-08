(component
  (type $call-type (func (param "request" string) (result (result string (error string)))))
  (import "moss:module/kv@1.0.0" (instance $kv
    (export "call" (func (type $call-type)))))
  (alias export $kv "call" (func $kv-call))
  (core module $memory
    (memory (export "memory") 4 1024)
    (global $heap (mut i32) (i32.const 65536))
    (func (export "realloc") (param i32 i32 i32 i32) (result i32)
      (local $old i32)
      global.get $heap local.tee $old local.get 3 i32.add global.set $heap
      local.get $old)
    (data (i32.const 128) "healthy"))
  (core instance $mem (instantiate $memory))
  (alias core export $mem "memory" (core memory $shared-memory))
  (alias core export $mem "realloc" (core func $realloc))
  (core func $lower-kv (canon lower (func $kv-call)
    (memory $shared-memory) (realloc (func $realloc))))
  (core module $guest
    (import "host" "memory" (memory 4 1024))
    (import "host" "kv" (func $kv (param i32 i32 i32)))
    (func (export "handle") (param $kind i32) (param i32) (param $payload i32) (param $length i32) (result i32)
      local.get $kind i32.load8_u i32.const 114 i32.eq
      if
        local.get $payload local.get $length i32.const 32 call $kv
      else
        i32.const 32 i32.const 0 i32.store
        i32.const 36 i32.const 128 i32.store
        i32.const 40 i32.const 7 i32.store
      end
      i32.const 32))
  (core instance $guest-instance (instantiate $guest
    (with "host" (instance
      (export "memory" (memory $shared-memory))
      (export "kv" (func $lower-kv))))))
  (alias core export $guest-instance "handle" (core func $handle))
  (func (export "handle") (param "kind" string) (param "payload" string)
    (result (result string (error string)))
    (canon lift (core func $handle)
      (memory $shared-memory) (realloc (func $realloc)))))
