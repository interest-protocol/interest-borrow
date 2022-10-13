// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../dinero-markets/LPFreeMarket.sol";

contract TestLPFreeMarket is LPFreeMarket {
    function setOracle(IPriceOracle oracle) external {
        ORACLE = oracle;
    }

    function setCollateralEarnings(uint256 amount) external {
        collateralEarnings += amount;
    }
}
