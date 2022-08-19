// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "../NativeTokenMarket.sol";

contract NativeTokenMarketDepositReentrancy {
    NativeTokenMarket internal market;

    constructor(NativeTokenMarket _market) {
        market = _market;
    }

    receive() external payable {
        market.deposit{value: msg.value}(address(this));
    }
}

contract NativeTokenMarketWithdrawReentrancy {
    NativeTokenMarket internal market;

    constructor(NativeTokenMarket _market) {
        market = _market;
    }

    receive() external payable {
        market.withdraw(address(this), 1);
    }
}

contract NativeTokenMarketReceiveReentrancy {
    NativeTokenMarket internal market;

    constructor(NativeTokenMarket _market) {
        market = _market;
    }

    receive() external payable {
        (bool sent, ) = address(market).call{value: msg.value}("");

        require(sent);
    }
}

contract NativeTokenMarketBorrowReentrancy {
    NativeTokenMarket internal market;

    constructor(NativeTokenMarket _market) {
        market = _market;
    }

    receive() external payable {
        market.borrow(address(this), 1);
    }
}

contract NativeTokenMarketRequestReentrancy {
    NativeTokenMarket internal market;

    constructor(NativeTokenMarket _market) {
        market = _market;
    }

    receive() external payable {
        uint256[] memory actions = new uint256[](1);
        actions[0] = 1;

        bytes[] memory args = new bytes[](1);
        args[0] = "";

        market.request(actions, args);
    }
}

contract NativeTokenMarketLiquidateReentrancy {
    NativeTokenMarket internal market;

    constructor(NativeTokenMarket _market) {
        market = _market;
    }

    receive() external payable {
        address[] memory accounts = new address[](1);

        uint256[] memory principals = new uint256[](1);

        market.liquidate(accounts, principals, address(this), "");
    }
}
