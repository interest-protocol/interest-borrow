//SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../synthetics/SyntheticMarket.sol";

contract SyntheticMarketV2 is SyntheticMarket {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
