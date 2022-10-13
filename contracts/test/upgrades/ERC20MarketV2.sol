//SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "../../dinero-markets/ERC20Market.sol";

contract ERC20MarketV2 is ERC20Market {
    function version() external pure returns (string memory) {
        return "v2";
    }
}
