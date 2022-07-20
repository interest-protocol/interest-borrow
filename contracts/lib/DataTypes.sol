// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

struct LiquidationInfo {
    uint256 allCollateral;
    uint128 allPrincipal;
    uint128 allFee;
}

struct LPFreeMarketUser {
    uint128 collateral;
    uint128 rewards;
    uint256 rewardDebt;
}
