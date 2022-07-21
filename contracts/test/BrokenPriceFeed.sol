// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

// Note Just to get the artifacts
import "@interest-protocol/dex/Factory.sol";
import "@interest-protocol/dex/Pair.sol";
import "@interest-protocol/dex/Router.sol";
import "@interest-protocol/tokens/InterestToken.sol";
import "@interest-protocol/tokens/Dinero.sol";

//solhint-disable
contract BrokenPriceFeed {
    uint256 public constant decimals = 6;

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {}
}
