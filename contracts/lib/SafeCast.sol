// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

library SafeCast {
    /**
     * @notice Casts a uint256 to uint128 for memory optimization
     *
     * @param x The uint256 that will be casted to uint128
     * @return y The uint128 version of `x`
     *
     * @dev It will revert if `x` is higher than 2**128 - 1
     */
    function toUint128(uint256 x) internal pure returns (uint128 y) {
        //solhint-disable-next-line no-inline-assembly
        assembly {
            if iszero(lt(x, shl(128, 1))) {
                revert(0, 0)
            }
            y := x
        }
    }
}
