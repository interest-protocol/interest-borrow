// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "../ERC20Market.sol";

contract TestERC20Market is ERC20Market {
    function setOracle(IPriceOracle oracle) external {
        ORACLE = oracle;
    }

    function setCollateralEarnings(uint256 amount) external {
        loanTerms.collateralEarned += uint128(amount);
    }
}
