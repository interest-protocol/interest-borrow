//SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

contract ZeroPriceOracle {
    function getTokenUSDPrice(address token, uint256 amount)
        external
        view
        returns (uint256 price)
    {
        price = 0;
    }
}
