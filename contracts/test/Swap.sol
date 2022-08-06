// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

contract Swap {
    event SellOneToken();
    event SellTwoTokens();

    function sellTwoTokens(
        bytes calldata data,
        address tokenA,
        address tokenB,
        uint256 amountA,
        uint256 amountB,
        uint256 debt
    ) external {
        emit SellTwoTokens();
    }

    function sellOneToken(
        bytes calldata data,
        address token,
        uint256 amount,
        uint256 debt
    ) external {
        emit SellOneToken();
    }
}
