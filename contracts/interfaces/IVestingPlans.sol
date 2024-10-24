// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

interface IVestingPlans {
    function createPlan(
    address recipient,
    address token,
    uint256 amount,
    uint256 start,
    uint256 cliff,
    uint256 rate,
    uint256 period,
    address vestingAdmin,
    bool adminTransferOBO
  ) external returns (uint256);

  function changeVestingPlanAdmin(uint256 planId, address newVestingAdmin) external;
}