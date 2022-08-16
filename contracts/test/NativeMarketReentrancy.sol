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
