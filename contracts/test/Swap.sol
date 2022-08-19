// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

contract Swap {
    event SellOneToken();
    event SellTwoTokens();
    event SellNativeToken();

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

    function sellNativeToken(
        bytes calldata data,
        uint256 amount,
        uint256 debt
    ) external {
        emit SellNativeToken();
    }

    receive() external payable {}
}
