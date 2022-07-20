// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

library Math {
    // Common scalar for ERC20 and native assets
    uint256 private constant SCALAR = 1e18;

    /**
     * @notice Taken from https://twitter.com/transmissions11/status/1451129626432978944/photo/1
     */
    function fmul(uint256 x, uint256 y) internal pure returns (uint256 z) {
        assembly {
            if iszero(or(iszero(x), eq(div(mul(x, y), x), y))) {
                revert(0, 0)
            }

            z := div(mul(x, y), SCALAR)
        }
    }

    /**
     * @notice fixed point math division with a scaling factor of 1/e18
     *
     * @param x first operand of the division
     * @param y second operand of the division
     * @return z The result of the division with a scaling factor of 1/1e18
     */
    function fdiv(uint256 x, uint256 y) internal pure returns (uint256 z) {
        assembly {
            if or(
                iszero(y),
                iszero(or(iszero(x), eq(div(mul(x, SCALAR), x), SCALAR)))
            ) {
                revert(0, 0)
            }
            z := div(mul(x, SCALAR), y)
        }
    }

    /**
     * @notice It scales the `amount` to a fixed point number with a scaling factor of 1/1e18
     *
     * @param amount The number that will be scaled to {WAD}
     * @param decimals The current exponential of the scaling factor of a base of 10
     * @return z The new `amount` scaled to a {WAD}
     */
    function adjust(uint256 amount, uint8 decimals)
        internal
        pure
        returns (uint256 z)
    {
        assembly {
            let divisor := exp(10, decimals)
            let isEqual := eq(decimals, SCALAR)

            if isEqual {
                z := amount
            }

            if iszero(isEqual) {
                if or(
                    iszero(divisor),
                    iszero(
                        or(
                            iszero(amount),
                            eq(div(mul(amount, SCALAR), amount), SCALAR)
                        )
                    )
                ) {
                    revert(0, 0)
                }

                z := div(mul(amount, SCALAR), divisor)
            }
        }
    }

    function sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}
