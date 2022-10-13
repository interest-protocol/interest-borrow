// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../dinero-markets/NativeTokenMarket.sol";

contract TestNativeTokenMarket is NativeTokenMarket {
    function setOracle(IPriceOracle oracle) external {
        ORACLE = oracle;
    }

    function setCollateralEarnings(uint256 amount) external {
        loanTerms.collateralEarned += uint128(amount);
    }

    function metadata()
        external
        view
        returns (
            address,
            address,
            address,
            uint256,
            uint96,
            uint128,
            LoanTerms memory
        )
    {
        return (
            address(DNR),
            address(ORACLE),
            address(treasury),
            maxLTVRatio,
            liquidationFee,
            maxBorrowAmount,
            loanTerms
        );
    }
}
