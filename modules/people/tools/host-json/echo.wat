(component
  (core module $echo
    (memory (export "memory") 4)
    (global $heap (mut i32) (i32.const 65536))
    (func (export "realloc") (param i32 i32 i32 i32) (result i32)
      (local $old i32)
      global.get $heap local.tee $old local.get 3 i32.add global.set $heap
      local.get $old)
    (func (export "handle") (param i32 i32) (param $payload i32) (param $length i32) (result i32)
      i32.const 32 i32.const 0 i32.store
      i32.const 36 local.get $payload i32.store
      i32.const 40 local.get $length i32.store
      i32.const 32))
  (core instance $instance (instantiate $echo))
  (func (export "handle") (param "kind" string) (param "payload" string)
    (result (result string (error string)))
    (canon lift (core func $instance "handle")
      (memory $instance "memory") (realloc (func $instance "realloc")))))
