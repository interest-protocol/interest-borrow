//SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "../../LPFreeMarket.sol";

contract LPFreeMarketV2 is LPFreeMarket {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
