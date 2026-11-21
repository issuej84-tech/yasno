#![no_std]

use core::panic::PanicInfo;
use core::ptr::addr_of_mut;

const CAPACITY: usize = 4096;
const MAX_DEPTH: u32 = 64;

#[panic_handler]
fn panic(_: &PanicInfo<'_>) -> ! {
    core::arch::wasm32::unreachable()
}

#[repr(C)]
struct Input {
    capacity: i32,
    padding: i32,
    data: [i32; CAPACITY],
}

struct Calculator {
    input: Input,
    error: i32,
    error_at: usize,
}

// The host creates one calculator per Wasm instance and uses it synchronously.
static mut CALCULATOR: Calculator = Calculator {
    input: Input {
        capacity: 0,
        padding: 0,
        data: [0; CAPACITY],
    },
    error: 0,
    error_at: 0,
};

#[no_mangle]
pub extern "C" fn create() -> usize {
    let calculator = addr_of_mut!(CALCULATOR);
    // Initialize the header at runtime so the zero buffer stays out of the Wasm file.
    unsafe { addr_of_mut!((*calculator).input.capacity).write(CAPACITY as i32) };
    calculator as usize
}

#[no_mangle]
pub unsafe extern "C" fn input_buffer(calculator: usize) -> usize {
    let calculator = calculator as *mut Calculator;
    addr_of_mut!((*calculator).input) as usize
}

#[no_mangle]
pub unsafe extern "C" fn error_code(calculator: usize) -> i32 {
    (*(calculator as *const Calculator)).error
}

#[no_mangle]
pub unsafe extern "C" fn error_position(calculator: usize) -> usize {
    (*(calculator as *const Calculator)).error_at
}

#[no_mangle]
pub unsafe extern "C" fn evaluate(calculator: usize, length: i32) -> f64 {
    let calculator = &mut *(calculator as *mut Calculator);
    if length < 0 || length as usize > CAPACITY {
        calculator.error = 7;
        calculator.error_at = CAPACITY;
        return 0.0;
    }
    let mut parser = Parser {
        input: &calculator.input.data[..length as usize],
        position: 0,
        error: 0,
        error_at: 0,
    };
    let mut result = parser.sum(0);
    if parser.error == 0 && parser.position != parser.input.len() {
        result = parser.fail(3, parser.position);
    }
    calculator.error = parser.error;
    calculator.error_at = parser.error_at;
    result
}

struct Parser<'a> {
    input: &'a [i32],
    position: usize,
    error: i32,
    error_at: usize,
}

impl Parser<'_> {
    fn fail(&mut self, code: i32, position: usize) -> f64 {
        self.error = code;
        self.error_at = position;
        0.0
    }

    fn current(&self) -> i32 {
        self.input.get(self.position).copied().unwrap_or(-1)
    }

    fn skip_space(&mut self) {
        while matches!(self.current(), 32 | 9 | 10 | 13) {
            self.position += 1;
        }
    }

    fn checked(&mut self, value: f64, position: usize) -> f64 {
        if value.is_finite() {
            value
        } else {
            self.fail(5, position)
        }
    }

    fn number(&mut self) -> f64 {
        let start = self.position;
        let mut value = 0.0;
        while let Some(digit) = digit(self.current()) {
            value = value * 10.0 + digit;
            self.position += 1;
        }
        let mut digits = self.position - start;
        if self.current() == i32::from(b'.') {
            self.position += 1;
            let fraction_start = self.position;
            let mut fraction = 0.0;
            let mut scale = 1.0;
            while let Some(digit) = digit(self.current()) {
                if self.position - fraction_start < 300 {
                    fraction = fraction * 10.0 + digit;
                    scale *= 10.0;
                }
                self.position += 1;
            }
            let fraction_digits = self.position - fraction_start;
            digits += fraction_digits;
            if fraction_digits <= 300 {
                value += fraction / scale;
            } else {
                // Read from the right to avoid overflowing the decimal scale.
                fraction = 0.0;
                for &ch in self.input[fraction_start..self.position].iter().rev() {
                    fraction = (fraction + f64::from(ch - i32::from(b'0'))) / 10.0;
                }
                value += fraction;
            }
        }
        if digits == 0 {
            return self.fail(1, start);
        }
        self.checked(value, start)
    }

    fn primary(&mut self, depth: u32) -> f64 {
        if self.current() != i32::from(b'(') {
            return self.number();
        }
        if depth == MAX_DEPTH {
            return self.fail(6, self.position);
        }
        self.position += 1;
        let value = self.sum(depth + 1);
        if self.error != 0 {
            return 0.0;
        }
        if self.current() != i32::from(b')') {
            return self.fail(2, self.position);
        }
        self.position += 1;
        value
    }

    fn unary(&mut self, depth: u32) -> f64 {
        self.skip_space();
        let mut negative = false;
        loop {
            match self.current() {
                43 => {}
                45 => negative = !negative,
                _ => break,
            }
            self.position += 1;
            self.skip_space();
        }
        let value = self.primary(depth);
        if negative { -value } else { value }
    }

    fn product(&mut self, depth: u32) -> f64 {
        let mut value = self.unary(depth);
        while self.error == 0 {
            self.skip_space();
            let op = self.current();
            if op != i32::from(b'*') && op != i32::from(b'/') {
                break;
            }
            let position = self.position;
            self.position += 1;
            let right = self.unary(depth);
            if self.error != 0 {
                return 0.0;
            }
            if op == i32::from(b'*') {
                value = self.checked(value * right, position);
            } else {
                if right == 0.0 {
                    return self.fail(4, position);
                }
                value = self.checked(value / right, position);
            }
        }
        value
    }

    fn sum(&mut self, depth: u32) -> f64 {
        let mut value = self.product(depth);
        while self.error == 0 {
            self.skip_space();
            let op = self.current();
            if op != i32::from(b'+') && op != i32::from(b'-') {
                break;
            }
            let position = self.position;
            self.position += 1;
            let right = self.product(depth);
            if self.error != 0 {
                return 0.0;
            }
            if op == i32::from(b'+') {
                value = self.checked(value + right, position);
            } else {
                value = self.checked(value - right, position);
            }
        }
        value
    }
}

fn digit(ch: i32) -> Option<f64> {
    let value = ch - i32::from(b'0');
    (0..=9).contains(&value).then(|| f64::from(value))
}
