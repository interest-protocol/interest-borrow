// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

interface IPriceOracle {
    function getTokenUSDPrice(address token, uint256 amount)
        external
        view
        returns (uint256 price);

    function getLPTokenUSDPrice(address pair, uint256 amount)
        external
        view
        returns (uint256 price);
}
