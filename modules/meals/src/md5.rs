//! MD5, written by hand because the approved crate list has no hash crate for it. It exists
//! only to derive the same kitchen and self-member ids the old database expression made with
//! `md5(text)::uuid`. It is not used for any security purpose.

const SHIFTS: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
    14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
    21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// The sine-derived constants from RFC 1321, computed so no table can be mistyped.
fn constant(i: usize) -> u32 {
    ((i as f64 + 1.0).sin().abs() * 4_294_967_296.0) as u32
}

pub fn digest(input: &[u8]) -> [u8; 16] {
    let mut state: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
    let mut message = input.to_vec();
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&((input.len() as u64).wrapping_mul(8)).to_le_bytes());
    for block in message.chunks(64) {
        let words: Vec<u32> = block
            .chunks(4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        let [mut a, mut b, mut c, mut d] = state;
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let next = a
                .wrapping_add(f)
                .wrapping_add(constant(i))
                .wrapping_add(words[g]);
            a = d;
            d = c;
            c = b;
            b = b.wrapping_add(next.rotate_left(SHIFTS[i]));
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
    }
    let mut out = [0u8; 16];
    for (chunk, word) in out.chunks_mut(4).zip(state) {
        chunk.copy_from_slice(&word.to_le_bytes());
    }
    out
}

/// What Postgres returns for `md5(text)::uuid`: the 32 hex digits regrouped as a uuid.
pub fn uuid_of(text: &str) -> String {
    let hex: String = digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(input: &str) -> String {
        digest(input.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn matches_the_rfc_1321_test_suite() {
        assert_eq!(hex(""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(hex("a"), "0cc175b9c0f1b6a831c399e269772661");
        assert_eq!(hex("abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(hex("message digest"), "f96b697d7cb7938d525a2f31aaf161d0");
        assert_eq!(hex("abcdefghijklmnopqrstuvwxyz"), "c3fcd3d76192e4007dfb496cca67e13b");
        assert_eq!(
            hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
            "57edf4a22be3c955ac49da2e2107b67a"
        );
    }

    #[test]
    fn groups_the_digest_like_a_uuid() {
        assert_eq!(uuid_of("abc"), "90015098-3cd2-4fb0-d696-3f7d28e17f72");
    }
}
