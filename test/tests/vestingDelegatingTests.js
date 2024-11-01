const C = require('../constants');
const { getSignature } = require('../helpers');
const setup = require('../fixtures');
const { expect } = require('chai');
const { time } = require('@nomicfoundation/hardhat-network-helpers');
const { createTree, getProof } = require('../merkleGenerator');
const { ethers } = require('hardhat');
const { v4: uuidv4, parse: uuidParse } = require('uuid');

const vestingDelegatingTests = (params, lockupParams) => {
  let deployed, dao, a, b, c, d, e, token, claimContract, vesting, domain, tokenDomain;
  let start, cliff, period, periods, end, vestingAdmin;
  let amount, remainder, campaign, claimLockup, claimA, claimB, claimC, claimD, claimE, id, treasury, feeAmount;
  it('DAO Creates a Vesting Claim Campaign', async () => {
    deployed = await setup(params.decimals);
    dao = deployed.dao;
    a = deployed.a;
    b = deployed.b;
    c = deployed.c;
    d = deployed.d;
    e = deployed.e;
    treasury = deployed.treasury;
    feeAmount = BigInt(7) * BigInt(10 ** 15);
    token = deployed.token;
    claimContract = deployed.claimContract;
    vesting = deployed.vesting;
    domain = deployed.claimDomain;
    tokenDomain = deployed.tokenDomain;
    let now = BigInt(await time.latest());
    start = lockupParams.start == 0 ? BigInt(0) : BigInt(lockupParams.start) + now;
    cliff = BigInt(lockupParams.cliff) + start;
    period = lockupParams.period;
    periods = BigInt(lockupParams.periods);
    end = start + periods;

    let treevalues = [];
    amount = BigInt(0);
    const uuid = uuidv4();
    id = uuidParse(uuid);
    for (let i = 0; i < params.totalRecipients; i++) {
      let wallet;
      let amt = C.randomBigNum(1000, 100, params.decimals);
      if (i == params.nodeA) {
        wallet = a.address;
        claimA = amt;
      } else if (i == params.nodeB) {
        wallet = b.address;
        claimB = amt;
      } else if (i == params.nodeC) {
        wallet = c.address;
        claimC = amt;
      } else if (i == params.nodeD) {
        wallet = d.address;
        claimD = amt;
      } else if (i == params.nodeE) {
        wallet = e.address;
        claimE = amt;
      } else {
        wallet = ethers.Wallet.createRandom().address;
      }
      amount = amt + amount;
      treevalues.push([wallet, amt.toString()]);
    }
    remainder = amount;
    const root = createTree(treevalues, ['address', 'uint256']);
    campaign = {
      manager: dao.address,
      token: token.target,
      amount,
      start: now,
      end: BigInt((await time.latest()) + 60 * 60),
      tokenLockup: 2,
      root,
      delegating: true,
    };
    claimLockup = {
      tokenLocker: vesting.target,
      start,
      cliff,
      period,
      periods,
    };
    vestingAdmin = dao.address;
    let treasuryBalance = BigInt(await ethers.provider.getBalance(treasury.address));
    const tx = await claimContract.createLockedCampaign(
      id,
      campaign,
      claimLockup,
      vestingAdmin,
      BigInt(treevalues.length),
      {value: feeAmount}
    );
    expect(tx).to.emit(claimContract, 'ClaimLockupCreated').withArgs(id, claimLockup);
    expect(tx).to.emit(claimContract, 'CampaignCreated').withArgs(id, campaign, BigInt(treevalues.length));
    expect(tx).to.emit(token, 'Transfer').withArgs(dao.target, claimContract.target, amount);
    expect(tx).to.emit(token, 'Approval').withArgs(claimContract.target, vesting.target, amount);
    expect(await ethers.provider.getBalance(claimContract.target)).to.eq(0);
    let paidTreasury = BigInt(await ethers.provider.getBalance(treasury.address));
    expect(paidTreasury).to.eq(treasuryBalance + feeAmount);
  });
  it('wallet A claims and delegates their tokens to itself using a real delegation signature', async () => {
    remainder = remainder - BigInt(claimA);
    let proof = getProof('./test/trees/tree.json', a.address);
    let delegatee = a.address;
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    let treasuryBalance = BigInt(await ethers.provider.getBalance(treasury.address));
    const tx = await claimContract.connect(a).claimAndDelegate(id, proof, claimA, delegatee, delegationSig, {value: feeAmount});
    expect(tx).to.emit(claimContract, 'Claimed').withArgs(id, a.address, claimA);
    expect(tx).to.emit(claimContract, 'TokensClaimed').withArgs(id, a.address, claimA, remainder);
    expect(tx).to.emit(token, 'Transfer').withArgs(claimContract.target, vesting.target, claimA);
    expect(await ethers.provider.getBalance(claimContract.target)).to.eq(0);
    let paidTreasury = BigInt(await ethers.provider.getBalance(treasury.address));
    expect(paidTreasury).to.eq(treasuryBalance + feeAmount);
    let rate = claimA % periods == 0 ? BigInt(claimA / periods) : BigInt(claimA / periods) + BigInt(1);
    let expectedStart = lockupParams.start == 0 ? BigInt((await time.latest())) : start;
    expect(tx)
      .to.emit(vesting, 'PlanCreated')
      .withArgs(1, vesting.target, token.target, claimA, start, cliff, end, rate, period, vesting.target, true);
    const votingVault = await vesting.votingVaults(1);
    expect(tx).to.emit(vesting, 'VotingVaultCreated').withArgs(1, votingVault);
    expect(tx).to.emit(vesting, 'VestingPlanAdminChanged').withArgs(1, vestingAdmin);
    expect(tx).to.emit(vesting, 'Transfer').withArgs(vesting.target, a.address, 1);
    expect(await token.delegates(votingVault)).to.eq(delegatee);
    expect(await token.balanceOf(votingVault)).to.eq(claimA);
    expect(await vesting.ownerOf(1)).to.eq(a.address);
    const plan = await vesting.plans(1);
    expect(plan.amount).to.eq(claimA);
    expect(plan.token).to.eq(token.target);
    expect(plan.start).to.eq(expectedStart);
    expect(plan.cliff).to.eq(cliff);
    expect(plan.period).to.eq(period);
    expect(plan.rate).to.eq(rate);
    expect(plan.vestingAdmin).to.eq(vestingAdmin);
    expect(await token.allowance(claimContract.target, vesting.target)).to.eq(0);
  });
  it('wallet B claims and delegates its tokens to wallet A', async () => {
    remainder = remainder - BigInt(claimB);
    let proof = getProof('./test/trees/tree.json', b.address);
    let delegatee = a.address;
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    const tx = await claimContract.connect(b).claimAndDelegate(id, proof, claimB, delegatee, delegationSig);
    expect(tx).to.emit(claimContract, 'Claimed').withArgs(id, b.address, claimB);
    expect(tx).to.emit(claimContract, 'TokensClaimed').withArgs(id, b.address, claimB, remainder);
    expect(tx).to.emit(token, 'Transfer').withArgs(claimContract.target, vesting.target, claimB);
    let rate = claimB % periods == 0 ? BigInt(claimB / periods) : BigInt(claimB / periods) + BigInt(1);
    let expectedStart = lockupParams.start == 0 ? BigInt((await time.latest())) : start;
    expect(tx)
      .to.emit(vesting, 'PlanCreated')
      .withArgs(2, vesting.target, token.target, claimB, start, cliff, end, rate, period, vesting.target, true);
    const votingVault = await vesting.votingVaults(2);
    expect(tx).to.emit(vesting, 'VotingVaultCreated').withArgs(2, votingVault);
    expect(tx).to.emit(vesting, 'VestingPlanAdminChanged').withArgs(2, vestingAdmin);
    expect(tx).to.emit(vesting, 'Transfer').withArgs(vesting.target, b.address, 2);
    expect(await token.delegates(votingVault)).to.eq(delegatee);
    expect(await token.balanceOf(votingVault)).to.eq(claimB);
    expect(await vesting.ownerOf(2)).to.eq(b.address);
    const plan = await vesting.plans(2);
    expect(plan.amount).to.eq(claimB);
    expect(plan.token).to.eq(token.target);
    expect(plan.start).to.eq(expectedStart);
    expect(plan.cliff).to.eq(cliff);
    expect(plan.period).to.eq(period);
    expect(plan.rate).to.eq(rate);
    expect(plan.vestingAdmin).to.eq(vestingAdmin);
    expect(await token.allowance(claimContract.target, vesting.target)).to.eq(0);
  });
  it('DAO claims on behalf of wallet C and delegates to wallet C', async () => {
    remainder = remainder - BigInt(claimC);
    let proof = getProof('./test/trees/tree.json', c.address);
    let delegatee = c.address;
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    let expiry = BigInt(await time.latest()) + BigInt(60 * 60 * 24 * 7);
    let nonce = 0;
    const txValues = {
      campaignId: id,
      claimer: c.address,
      claimAmount: claimC,
      delegatee,
      nonce,
      expiry,
    };
    const txSignature = await getSignature(c, domain, C.delegatingClaimType, txValues);
    const txSig = {
      nonce,
      expiry,
      v: txSignature.v,
      r: txSignature.r,
      s: txSignature.s,
    };
    const tx = await claimContract
      .connect(dao)
      .claimAndDelegateWithSig(id, proof, c.address, claimC, txSig, delegatee, delegationSig);
    expect(tx).to.emit(claimContract, 'Claimed').withArgs(id, c.address, claimC);
    expect(tx).to.emit(claimContract, 'TokensClaimed').withArgs(id, c.address, claimC, remainder);
    expect(tx).to.emit(token, 'Transfer').withArgs(claimContract.target, vesting.target, claimC);
    let rate = claimC % periods == 0 ? BigInt(claimC / periods) : BigInt(claimC / periods) + BigInt(1);
    let expectedStart = lockupParams.start == 0 ? BigInt((await time.latest())) : start;
    expect(tx)
      .to.emit(vesting, 'PlanCreated')
      .withArgs(3, vesting.target, token.target, claimC, start, cliff, end, rate, period, vesting.target, true);
    const votingVault = await vesting.votingVaults(3);
    expect(tx).to.emit(vesting, 'VotingVaultCreated').withArgs(3, votingVault);
    expect(tx).to.emit(vesting, 'VestingPlanAdminChanged').withArgs(3, vestingAdmin);
    expect(tx).to.emit(vesting, 'Transfer').withArgs(vesting.target, c.address, 3);
    expect(await token.delegates(votingVault)).to.eq(delegatee);
    expect(await token.balanceOf(votingVault)).to.eq(claimC);
    expect(await vesting.ownerOf(3)).to.eq(c.address);
    const plan = await vesting.plans(3);
    expect(plan.amount).to.eq(claimC);
    expect(plan.token).to.eq(token.target);
    expect(plan.start).to.eq(expectedStart);
    expect(plan.cliff).to.eq(cliff);
    expect(plan.period).to.eq(period);
    expect(plan.rate).to.eq(rate);
    expect(plan.vestingAdmin).to.eq(vestingAdmin);
    expect(await token.allowance(claimContract.target, vesting.target)).to.eq(0);
  });
  it('DAO claims on behalf of wallet D and delegates to wallet A', async () => {
    remainder = remainder - BigInt(claimD);
    let proof = getProof('./test/trees/tree.json', d.address);
    let delegatee = a.address;
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    let expiry = BigInt(await time.latest()) + BigInt(60 * 60 * 24 * 7);
    let nonce = 0;
    const txValues = {
      campaignId: id,
      claimer: d.address,
      claimAmount: claimD,
      delegatee,
      nonce,
      expiry,
    };
    const txSignature = await getSignature(d, domain, C.delegatingClaimType, txValues);
    const txSig = {
      nonce,
      expiry,
      v: txSignature.v,
      r: txSignature.r,
      s: txSignature.s,
    };
    const tx = await claimContract
      .connect(dao)
      .claimAndDelegateWithSig(id, proof, d.address, claimD, txSig, delegatee, delegationSig);
    expect(tx).to.emit(claimContract, 'Claimed').withArgs(id, d.address, claimD);
    expect(tx).to.emit(claimContract, 'TokensClaimed').withArgs(id, d.address, claimD, remainder);
    expect(tx).to.emit(token, 'Transfer').withArgs(claimContract.target, vesting.target, claimD);
    let rate = claimD % periods == 0 ? BigInt(claimD / periods) : BigInt(claimD / periods) + BigInt(1);
    let expectedStart = lockupParams.start == 0 ? BigInt((await time.latest())) : start;
    expect(tx)
      .to.emit(vesting, 'PlanCreated')
      .withArgs(4, vesting.target, token.target, claimD, start, cliff, end, rate, period, vesting.target, true);
    const votingVault = await vesting.votingVaults(4);
    expect(tx).to.emit(vesting, 'VotingVaultCreated').withArgs(4, votingVault);
    expect(tx).to.emit(vesting, 'VestingPlanAdminChanged').withArgs(4, vestingAdmin);
    expect(tx).to.emit(vesting, 'Transfer').withArgs(vesting.target, d.address, 4);
    expect(await token.delegates(votingVault)).to.eq(delegatee);
    expect(await token.balanceOf(votingVault)).to.eq(claimD);
    expect(await vesting.ownerOf(4)).to.eq(d.address);
    const plan = await vesting.plans(4);
    expect(plan.amount).to.eq(claimD);
    expect(plan.token).to.eq(token.target);
    expect(plan.start).to.eq(expectedStart);
    expect(plan.cliff).to.eq(cliff);
    expect(plan.period).to.eq(period);
    expect(plan.rate).to.eq(rate);
    expect(plan.vestingAdmin).to.eq(vestingAdmin);
    expect(await token.allowance(claimContract.target, vesting.target)).to.eq(0);
  });
};

const vestingDelegatingErrorTests = () => {
  let deployed, dao, a, b, c, d, e, token, claimContract, lockup, domain;
  let start, cliff, period, periods, end;
  let amount, root, campaign, claimLockup, claimA, claimB, claimC, claimD, claimE, id, firstId;
  it('Creation will fail if the user does not have enough tokens', async () => {
    deployed = await setup(18);
    dao = deployed.dao;
    a = deployed.a;
    b = deployed.b;
    c = deployed.c;
    d = deployed.d;
    e = deployed.e;
    token = deployed.token;
    claimContract = deployed.claimContract;
    lockup = deployed.vesting;
    domain = deployed.claimDomain;
    let now = BigInt(await time.latest());
    start = now;
    cliff = start;
    period = 1;
    periods = BigInt(600);
    end = start + periods;
    let treevalues = [];
    amount = BigInt(0);
    const uuid = uuidv4();
    id = uuidParse(uuid);
    for (let i = 0; i < 10; i++) {
      let wallet;
      let amt = C.randomBigNum(1000, 100, 18);
      if (i == 0) {
        wallet = a.address;
        claimA = amt;
      } else if (i == 1) {
        wallet = b.address;
        claimB = amt;
      } else if (i == 2) {
        wallet = c.address;
        claimC = amt;
      } else {
        wallet = ethers.Wallet.createRandom().address;
      }
      amount = amt + amount;
      treevalues.push([wallet, amt.toString()]);
    }
    root = createTree(treevalues, ['address', 'uint256']);
    campaign = {
      manager: dao.address,
      token: token.target,
      amount,
      start: now,
      end: BigInt((await time.latest()) + 60 * 60),
      tokenLockup: 2,
      root,
      delegating: true,
    };
    claimLockup = {
      tokenLocker: lockup.target,
      start,
      cliff,
      period,
      periods,
    };
    await token.connect(a).approve(claimContract.target, amount);
    await expect(
      claimContract.connect(a).createLockedCampaign(id, campaign, claimLockup, dao.address, BigInt(treevalues.length))
    ).to.be.revertedWith('THL01');
    firstId = id;
  });
  it('create will revert if the user does not provide approval', async () => {
    await token.connect(dao).approve(claimContract.target, 0);
    await expect(claimContract.connect(dao).createLockedCampaign(id, campaign, claimLockup, dao.address, 0)).to.be
      .reverted;
  });
  it('create will revert if the admin is the 0 address', async () => {
    await expect(
      claimContract.connect(dao).createLockedCampaign(id, campaign, claimLockup, C.ZERO_ADDRESS, 0)
    ).to.be.revertedWith('0_admin');
  });
  it('create will revert if the claim id has already been used', async () => {
    await token.approve(claimContract.target, amount * BigInt(10000));
    await claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0);
    await expect(claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0)).to.be.revertedWith(
      'in use'
    );
  });
  it('create will revert with a token address of 0x0', async () => {
    campaign.token = C.ZERO_ADDRESS;
    const uuid = uuidv4();
    id = uuidParse(uuid);
    await expect(claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0)).to.be.revertedWith(
      '0_address'
    );
  });
  it('create will revert with a 0x0 manager address', async () => {
    campaign.manager = C.ZERO_ADDRESS;
    campaign.token = token.target;
    await expect(claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0)).to.be.revertedWith(
      '0_manager'
    );
  });
  it('create will fail if the amount is 0', async () => {
    campaign.manager = dao.address;
    campaign.amount = 0;
    await expect(claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0)).to.be.revertedWith(
      '0_amount'
    );
  });
  it('create will fail if the end date is in the past', async () => {
    campaign.amount = amount;
    campaign.end = BigInt(await time.latest()) - BigInt(10);
    await expect(claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0)).to.be.revertedWith(
      'end error'
    );
  });
  it('create will fail if the lockup type is set to unlocked', async () => {
    campaign.end = BigInt(await time.latest()) + BigInt(1000);
    campaign.tokenLockup = 0;
    await expect(claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0)).to.be.revertedWith(
      '!locked'
    );
  });
  it('will revert if a non-manager tries to cancel', async () => {
    campaign.tokenLockup = 1;
    await expect(claimContract.connect(a).cancelCampaigns([id])).to.be.revertedWith('!manager');
  });
  it('user cannot claim if the campaign has not started', async () => {
    campaign.start = BigInt(await time.latest()) + BigInt(1000);
    campaign.end = BigInt(await time.latest()) + BigInt(2000);
    campaign.tokenLockup = 1;
    const uuid = uuidv4();
    id = uuidParse(uuid);
    await claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0);
    let proof = getProof('./test/trees/tree.json', a.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract.connect(a).claimAndDelegate(id, proof, claimA, a.address, delegationSig)
    ).to.be.revertedWith('!started');
  });
  it('user cannot claim if the campaign has ended', async () => {
    campaign.start = BigInt(await time.latest());
    campaign.end = BigInt(await time.latest()) + BigInt(10);
    const uuid = uuidv4();
    id = uuidParse(uuid);
    await claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0);
    let proof = getProof('./test/trees/tree.json', a.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await time.increase(11);
    await expect(
      claimContract.connect(a).claimAndDelegate(id, proof, claimA, a.address, delegationSig)
    ).to.be.revertedWith('campaign ended');
  });
  it('user cannot claim if the campaign has been cancelled', async () => {
    campaign.start = BigInt(await time.latest());
    campaign.end = BigInt(await time.latest()) + BigInt(10);
    const uuid = uuidv4();
    id = uuidParse(uuid);
    await claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0);
    await claimContract.connect(dao).cancelCampaigns([id]);
    let proof = getProof('./test/trees/tree.json', a.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract.connect(a).claimAndDelegate(id, proof, claimA, a.address, delegationSig)
    ).to.be.revertedWith('campaign ended');
  });
  it('user cannot claim if the amount provided in the function is wrong', async () => {
    campaign.start = BigInt(await time.latest());
    campaign.end = BigInt(await time.latest()) + BigInt(100);
    const uuid = uuidv4();
    id = uuidParse(uuid);
    await claimContract.createLockedCampaign(id, campaign, claimLockup, dao.address, 0);
    let proof = getProof('./test/trees/tree.json', a.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract.connect(a).claimAndDelegate(id, proof, claimA + BigInt(1), a.address, delegationSig)
    ).to.be.revertedWith('Invalid proof');
  });
  it('user cannot claim if they are not on the merkle tree', async () => {
    let proof = getProof('./test/trees/tree.json', a.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract.connect(e).claimAndDelegate(id, proof, claimA, a.address, delegationSig)
    ).to.be.revertedWith('Invalid proof');
  });
  it('user cannot claim if the proof is wrong', async () => {
    let proof = getProof('./test/trees/tree.json', b.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract.connect(a).claimAndDelegate(id, proof, claimA, a.address, delegationSig)
    ).to.be.revertedWith('Invalid proof');
  });
  it('user cannot claim from a different campaign id', async () => {
    const uuid = uuidv4();
    let fakeId = uuidParse(uuid);
    let proof = getProof('./test/trees/tree.json', a.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract.connect(a).claimAndDelegate(fakeId, proof, claimA, a.address, delegationSig)
    ).to.be.revertedWith('campaign ended');
  });
  it('user cannot claim if they have already claimed', async () => {
    let proof = getProof('./test/trees/tree.json', a.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await claimContract.connect(a).claimAndDelegate(firstId, proof, claimA, a.address, delegationSig);
    await expect(
      claimContract.connect(a).claimAndDelegate(firstId, proof, claimA, a.address, delegationSig)
    ).to.be.revertedWith('already claimed');
  });
  it('user cannot claim with the 0x0 delegatee address', async () => {
    let proof = getProof('./test/trees/tree.json', b.address);
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract.connect(b).claimAndDelegate(firstId, proof, claimB, C.ZERO_ADDRESS, delegationSig)
    ).to.be.revertedWith('0_delegatee');
  });
  it('user cannot use the function that does not delegate for the delegated claims', async () => {
    let proof = getProof('./test/trees/tree.json', b.address);
    await expect(claimContract.connect(b).claim(firstId, proof, claimB)).to.be.revertedWith('must delegate');
  });
  it('user cannot claim with the wrong claim signature when claiming on behalf', async () => {
    let proof = getProof('./test/trees/tree.json', b.address);
    let delegatee = c.address;
    let expiry = BigInt(await time.latest()) + BigInt(60 * 60 * 24 * 7);
    let nonce = 0;
    const txValues = {
      campaignId: firstId,
      claimer: c.address,
      claimAmount: claimB,
      delegatee,
      nonce,
      expiry,
    };
    const txSignature = await getSignature(b, domain, C.delegatingClaimType, txValues);
    const txSig = {
      nonce,
      expiry,
      v: txSignature.v,
      r: txSignature.r,
      s: txSignature.s,
    };
    const bytes = ethers.encodeBytes32String('blank');
    const delegationSig = {
      nonce: 0,
      expiry: 0,
      v: 0,
      r: bytes,
      s: bytes,
    };
    await expect(
      claimContract
        .connect(dao)
        .claimAndDelegateWithSig(firstId, proof, b.address, claimB, txSig, delegatee, delegationSig)
    ).to.be.revertedWith('invalid claim signature');
  });
};

module.exports = {
  vestingDelegatingTests,
  vestingDelegatingErrorTests,
};
