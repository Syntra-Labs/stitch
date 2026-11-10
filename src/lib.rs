#![no_std]

pub use uor_foundation::enforcement::{
    CertificateKind, ContentAddress, ContentFingerprint, GroundedCoord, Hasher, ReplayError, Trace,
    TraceEvent,
};
pub use uor_foundation::{PrimitiveOp, WittLevel};

/// 128-bit FNV-1a substrate `Hasher` impl from `UOR-Foundation/UOR-Framework` (`uor-foundation-test-helpers`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Fnv1aHasher16 {
    state: u128,
}

impl Hasher for Fnv1aHasher16 {
    const OUTPUT_BYTES: usize = 16;

    #[inline]
    fn initial() -> Self {
        Self {
            state: 0x6c62272e07bb014262b821756295c58d,
        }
    }

    #[inline]
    fn fold_byte(self, b: u8) -> Self {
        const PRIME: u128 = 0x0000000001000000000000000000013b;
        Self {
            state: (self.state ^ (b as u128)).wrapping_mul(PRIME),
        }
    }

    #[inline]
    fn finalize(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        let bytes = self.state.to_be_bytes();
        let mut i = 0;
        while i < 16 {
            out[i] = bytes[i];
            i += 1;
        }
        out
    }
}

/// 256-bit dual-lane FNV-1a substrate `Hasher` impl from `UOR-Foundation/UOR-Framework`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Fnv1aHasher32 {
    lo: u128,
    hi: u128,
}

impl Hasher for Fnv1aHasher32 {
    const OUTPUT_BYTES: usize = 32;

    #[inline]
    fn initial() -> Self {
        Self {
            lo: 0x6c62272e07bb014262b821756295c58d,
            hi: 0x9e3779b97f4a7c15f39cc0605cedc834,
        }
    }

    #[inline]
    fn fold_byte(self, b: u8) -> Self {
        const PRIME: u128 = 0x0000000001000000000000000000013b;
        Self {
            lo: (self.lo ^ (b as u128)).wrapping_mul(PRIME),
            hi: (self.hi ^ ((b as u128) ^ 0x55)).wrapping_mul(PRIME),
        }
    }

    #[inline]
    fn finalize(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        let lo_bytes = self.lo.to_be_bytes();
        let hi_bytes = self.hi.to_be_bytes();
        let mut i = 0;
        while i < 16 {
            out[i] = lo_bytes[i];
            out[i + 16] = hi_bytes[i];
            i += 1;
        }
        out
    }
}

/// Compute a `ContentFingerprint` and `ContentAddress` using `uor_foundation::enforcement::Hasher`.
#[inline]
#[must_use]
pub fn mint_uor_fingerprint_16(bytes: &[u8]) -> (ContentAddress, ContentFingerprint) {
    let buf = Fnv1aHasher16::initial().fold_bytes(bytes).finalize();
    let fp = ContentFingerprint::from_buffer(buf, Fnv1aHasher16::OUTPUT_BYTES as u8);
    let mut hi16 = [0u8; 16];
    let mut i = 0;
    while i < 16 {
        hi16[i] = buf[i];
        i += 1;
    }
    let addr = ContentAddress::from_u128(u128::from_be_bytes(hi16));
    (addr, fp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uor_foundation_content_address_and_coords_conform() {
        let (addr, fp) = mint_uor_fingerprint_16(&[1, 2, 3, 4]);
        assert!(!addr.is_zero());
        assert_eq!(addr.as_u128(), 0x66a5cdda2e757277b806e89ae7615aa5_u128);
        assert_eq!(fp.width_bytes(), 16);
        assert_eq!(fp.width_bits(), 128);

        let coord = GroundedCoord::w64(0x1234_5678_9abc_def0);
        assert_eq!(coord, GroundedCoord::w64(0x1234_5678_9abc_def0));
    }
}
