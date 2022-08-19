// SPDX-License-Identifier: MIT
pragma solidity >=0.8.9;

interface INativeTokenMarket {
    function treasury() external view returns (address);

    function liquidationFee() external view returns (uint96);

    function maxBorrowAmount() external view returns (uint128);

    function maxLTVRatio() external view returns (uint128);

    function loan() external view returns (uint128 elastic, uint128 base);

    function loanTerms()
        external
        view
        returns (
            uint128 lastAccrued,
            uint128 interestRate,
            uint128 dnrEarned,
            uint128 collateralEarned
        );

    function accountOf(address account)
        external
        view
        returns (uint128 collateral, uint128 principal);

    function getDineroEarnings() external;

    function getCollateralEarnings() external;

    function accrue() external;

    function deposit(address to) external payable;

    function withdraw(address to, uint256 amount) external;

    function borrow(address to, uint256 amount) external;

    function repay(address account, uint256 amount) external;

    function request(uint256[] calldata requests, bytes[] calldata requestArgs)
        external
        payable;

    function liquidate(
        address[] calldata accounts,
        uint256[] calldata principals,
        address recipient,
        bytes calldata data
    ) external;
}
