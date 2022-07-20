// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

interface InvestInterface {
    function deposit(
        address from,
        address to,
        uint256 amount
    ) external;
}
