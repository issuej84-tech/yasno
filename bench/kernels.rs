#![no_std]

use core::panic::PanicInfo;

#[panic_handler]
fn panic(_: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

fn is_prime(number: i32) -> bool {
    let mut divisor = 2;
    while divisor <= number / divisor {
        if number % divisor == 0 {
            return false;
        }
        divisor += 1;
    }
    true
}

#[no_mangle]
pub extern "C" fn count_primes(limit: i32) -> i32 {
    let mut count = 0;
    for number in 2..limit {
        if is_prime(number) {
            count += 1;
        }
    }
    count
}

#[no_mangle]
pub extern "C" fn checksum(rounds: u32, seed: u32) -> u32 {
    let mut state = seed;
    for i in 0..rounds {
        state ^= state >> 16;
        state = state.wrapping_mul(0x7feb_352d).wrapping_add(i);
    }
    state
}
