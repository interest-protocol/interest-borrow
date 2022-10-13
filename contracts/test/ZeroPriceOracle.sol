//SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

contract ZeroPriceOracle {
    function getTokenUSDPrice(address token, uint256 amount)
        external
        view
        returns (uint256 price)
    {}

    function getNativeTokenUSDPrice(uint256 amount)
        external
        view
        returns (uint256 price)
    {}
}
