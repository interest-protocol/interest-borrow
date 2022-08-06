// SPDX-License-Identifier: MIT
pragma solidity 0.8.15;

contract PriceFeed {
    uint256 public price;

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
    {
        answer = int256(price);
    }

    function decimals() external view returns (uint8) {
        return 8;
    }

    function setPrice(uint256 _price) external {
        price = _price;
    }
}
