//SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "../../ERC20Market.sol";

contract ERC20MarketV2 is ERC20Market {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
