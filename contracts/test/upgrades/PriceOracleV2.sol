//SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../PriceOracle.sol";

contract PriceOracleV2 is PriceOracle {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
