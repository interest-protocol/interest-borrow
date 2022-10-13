//SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../dinero-markets/NativeTokenMarket.sol";

contract NativeTokenMarketV2 is NativeTokenMarket {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
