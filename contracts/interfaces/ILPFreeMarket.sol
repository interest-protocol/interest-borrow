// SPDX-License-Identifier: MIT
pragma solidity >=0.8.9;

interface ILPFreeMarket {
    function COLLATERAL() external view returns (address);

    function liquidationFee() external view returns (uint96);

    function POOL_ID() external view returns (uint96);

    function maxLTVRatio() external view returns (uint128);

    function totalCollateral() external view returns (uint128);

    function totalPrincipal() external view returns (uint128);

    function maxBorrowAmount() external view returns (uint128);

    function totalRewardsPerToken() external view returns (uint256);

    function accountOf(address account)
        external
        view
        returns (
            uint128 collateral,
            uint128 rewards,
            uint256 rewardDebt,
            uint256 principal
        );

    function collateralEarnings() external view returns (uint256);

    function treasury() external view returns (address);
}
