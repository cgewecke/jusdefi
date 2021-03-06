const {
  BN,
  balance,
  constants,
  send,
  time,
  expectRevert,
} = require('@openzeppelin/test-helpers');

const {
  uniswapRouter,
  weth,
} = require('../data/deployments.json');

const AirdropToken = artifacts.require('AirdropToken');
const JusDeFi = artifacts.require('JusDeFiMock');
const FeePool = artifacts.require('FeePool');
const JDFIStakingPool = artifacts.require('JDFIStakingPool');
const UNIV2StakingPool = artifacts.require('UNIV2StakingPool');
const IUniswapV2Pair = artifacts.require('IUniswapV2Pair');
const IUniswapV2Router02 = artifacts.require('IUniswapV2Router02');
const IERC20 = artifacts.require('IERC20');

contract('FeePool', function (accounts) {
  const [NOBODY, DEPLOYER, ...DEPOSITORS] = accounts;

  let airdropToken;
  let jusdefi;
  let instance;

  beforeEach(async function () {
    airdropToken = await AirdropToken.new({ from: DEPLOYER });
    jusdefi = await JusDeFi.new(airdropToken.address, uniswapRouter, { from: DEPLOYER });
    await airdropToken.setJDFIStakingPool(await jusdefi._jdfiStakingPool.call(), { from: DEPLOYER });

    await time.increaseTo(await jusdefi._liquidityEventClosedAt.call());
    await jusdefi.liquidityEventDeposit({ from: DEPOSITORS[0], value: new BN(web3.utils.toWei('1')) });
    await jusdefi.liquidityEventClose();

    instance = await FeePool.at(await jusdefi._feePool.call());
  });

  describe('constructor', function () {
    it('sets initial fee to 10%', async function () {
      assert((await instance._fee.call()).eq(new BN(1000)));
    });

    it('approves Uniswap Router to spend UNI-V2', async function () {
      let pair = await IUniswapV2Pair.at(await jusdefi._uniswapPair.call());
      assert((await pair.allowance.call(instance.address, uniswapRouter)).eq(constants.MAX_UINT256));
    });
  });

  describe('receive', function () {
    describe('reverts if', function () {
      it('sender is not Uniswap Router', async function () {
        await expectRevert(
          send.ether(NOBODY, instance.address, new BN(1)),
          'JusDeFi: invalid ETH deposit'
        );
      });
    });
  });

  describe('#vote', function () {
    it('records vote for fee increase or decrease weighted by message value', async function () {
      let value = new BN(web3.utils.toWei('1'));

      assert((await instance._votesIncrease.call()).isZero());
      await instance.vote(true, { from: NOBODY, value });
      assert((await instance._votesIncrease.call()).eq(value));

      assert((await instance._votesDecrease.call()).isZero());
      await instance.vote(false, { from: NOBODY, value });
      assert((await instance._votesDecrease.call()).eq(value));
    });
  });

  describe('#buyback', function () {
    it('divests of Uniswap liquidity if total supply exceeds initial supply', async function () {
      while (new Date(await time.latest() * 1000).getUTCDay() !== 5) {
        await time.increase(60 * 60 * 24);
      }

      let pair = await IUniswapV2Pair.at(await jusdefi._uniswapPair.call());
      let router = await IUniswapV2Router02.at(uniswapRouter);

      let value = (await jusdefi.balanceOf.call(pair.address)).div(new BN(4)).mul(new BN(2)).div(new BN(3));
      await jusdefi.mint(NOBODY, value.mul(new BN(8)));

      await router.addLiquidityETH(
        jusdefi.address,
        value.mul(new BN(4)),
        value.mul(new BN(4)),
        value,
        NOBODY,
        constants.MAX_UINT256,
        { from: NOBODY, value }
      );

      let excess = await pair.balanceOf.call(NOBODY);

      let initialBalance = await pair.balanceOf.call(instance.address);
      await instance.buyback();
      let finalBalance = await pair.balanceOf.call(instance.address);

      assert(initialBalance.sub(excess).eq(finalBalance));

      await time.increase(60 * 60 * 24 * 7);

      // after buyback, price is no longer 1:4

      await router.addLiquidityETH(
        jusdefi.address,
        value.mul(new BN(4)),
        new BN(0),
        value,
        NOBODY,
        constants.MAX_UINT256,
        { from: NOBODY, value }
      );

      await instance.buyback();

      assert((await pair.balanceOf.call(instance.address)).isZero());
    });

    it('purchases and burns JDFI from Uniswap using ETH balance', async function () {
      while (new Date(await time.latest() * 1000).getUTCDay() !== 5) {
        await time.increase(60 * 60 * 24);
      }

      let pair = await IUniswapV2Pair.at(await jusdefi._uniswapPair.call());
      let router = await IUniswapV2Router02.at(uniswapRouter);

      let value = (await jusdefi.balanceOf.call(pair.address)).div(new BN(4)).mul(new BN(2)).div(new BN(3));
      await jusdefi.mint(NOBODY, value.mul(new BN(8)));

      // buyback with withdrawn liquidity

      await router.addLiquidityETH(
        jusdefi.address,
        value.mul(new BN(4)),
        value.mul(new BN(4)),
        value,
        NOBODY,
        constants.MAX_UINT256,
        { from: NOBODY, value }
      );

      // buyback with vote ETH

      await instance.vote(true, { from: NOBODY, value });

      let initialSupply = await jusdefi.totalSupply.call();
      let initialBalance = await jusdefi.balanceOf.call(await jusdefi._uniswapPair.call());

      await instance.buyback();

      let finalSupply = await jusdefi.totalSupply.call();
      let finalBalance = await jusdefi.balanceOf.call(await jusdefi._uniswapPair.call());

      assert((await balance.current(instance.address)).isZero());
      assert(!initialSupply.sub(finalSupply).isZero());
      assert(initialSupply.sub(finalSupply).eq(initialBalance.sub(finalBalance)));
    });

    it('does not burn JDFI pending distribution as rewards', async function () {
      await jusdefi.mint(instance.address, new BN(web3.utils.toWei('1')));

      while (new Date(await time.latest() * 1000).getUTCDay() !== 5) {
        await time.increase(60 * 60 * 24);
      }

      assert((await balance.current(instance.address)).isZero());

      let initialBalance = await jusdefi.balanceOf.call(instance.address);
      await instance.buyback();
      let finalBalance = await jusdefi.balanceOf.call(instance.address);

      // no tokens burned because held balance was reserved as rewards
      assert(!finalBalance.isZero());
      assert(initialBalance.eq(finalBalance));
    });

    it('executes buyback if no JDFI trades have taken place over the last 5 minutes', async function () {
      while (new Date(await time.latest() * 1000).getUTCDay() !== 5) {
        await time.increase(60 * 60 * 24);
      }

      await instance.vote(true, { from: NOBODY, value: new BN(web3.utils.toWei('1')) });

      let router = await IUniswapV2Router02.at(uniswapRouter);

      let wethContract = await IERC20.at(weth);

      let balance = await wethContract.balanceOf.call(await jusdefi._uniswapPair.call());

      await router.swapExactETHForTokens(
        new BN(0),
        [weth, jusdefi.address],
        NOBODY,
        constants.MAX_UINT256,
        { from: NOBODY, value: balance.div(new BN(10000)) }
      );

      await router.swapExactETHForTokens(
        new BN(0),
        [weth, jusdefi.address],
        NOBODY,
        constants.MAX_UINT256,
        { from: NOBODY, value: balance.div(new BN(10)) }
      );


      await time.increase(60 * 6);

      // no revert
      await instance.buyback();
    });

    it('executes buyback if JDFI trades have taken place over the last 5 minutes and price slippage is not too high', async function () {
      while (new Date(await time.latest() * 1000).getUTCDay() !== 5) {
        await time.increase(60 * 60 * 24);
      }

      await instance.vote(true, { from: NOBODY, value: new BN(web3.utils.toWei('1')) });

      let router = await IUniswapV2Router02.at(uniswapRouter);

      let wethContract = await IERC20.at(weth);

      let value = (await wethContract.balanceOf.call(await jusdefi._uniswapPair.call())).div(new BN(10));

      await router.swapExactETHForTokens(
        new BN(0),
        [weth, jusdefi.address],
        NOBODY,
        constants.MAX_UINT256,
        { from: NOBODY, value }
      );

      await router.swapExactTokensForETH(
        await jusdefi.balanceOf.call(NOBODY),
        new BN(0),
        [jusdefi.address, weth],
        NOBODY,
        constants.MAX_UINT256,
        { from: NOBODY }
      );

      await time.increase(60 * 4);

      // no revert
      await instance.buyback();
    });

    describe('reverts if', function () {
      it('date is not Friday (UTC)', async function () {
        if (new Date(await time.latest() * 1000).getUTCDay() === 5) {
          await time.increase(60 * 60 * 24);
        }

        await expectRevert(
          instance.buyback(),
          'JusDeFi: buyback must take place on Friday (UTC)'
        );
      });

      it('last call was made within current day', async function () {
        while (new Date(await time.latest() * 1000).getUTCDay() !== 5) {
          await time.increase(60 * 60 * 24);
        }

        await instance.buyback();

        await expectRevert(
          instance.buyback(),
          'JusDeFi: buyback already called this week'
        );
      });

      it('price slippage is too high', async function () {
        while (new Date(await time.latest() * 1000).getUTCDay() !== 5) {
          await time.increase(60 * 60 * 24);
        }

        await instance.vote(true, { from: NOBODY, value: new BN(web3.utils.toWei('1')) });

        let router = await IUniswapV2Router02.at(uniswapRouter);

        let wethContract = await IERC20.at(weth);

        let balance = await wethContract.balanceOf.call(await jusdefi._uniswapPair.call());

        await router.swapExactETHForTokens(
          new BN(0),
          [weth, jusdefi.address],
          NOBODY,
          constants.MAX_UINT256,
          { from: NOBODY, value: balance.div(new BN(10000)) }
        );

        await router.swapExactETHForTokens(
          new BN(0),
          [weth, jusdefi.address],
          NOBODY,
          constants.MAX_UINT256,
          { from: NOBODY, value: balance.div(new BN(10)) }
        );

        await expectRevert(
          instance.buyback(),
          'JusDeFi: buyback price slippage too high'
        );
      });
    });
  });

  describe('#rebase', function () {
    it('distributes accrued JDFI to staking pools', async function () {
      let [jdfiStaker, uniswapStaker] = DEPOSITORS;
      let amount = new BN(web3.utils.toWei('1'));
      await jusdefi.mint(instance.address, amount);

      let jdfiStakingPool = await JDFIStakingPool.at(await jusdefi._jdfiStakingPool.call());
      let univ2StakingPool = await UNIV2StakingPool.at(await jusdefi._univ2StakingPool.call());
      let pair = await IUniswapV2Pair.at(await jusdefi._uniswapPair.call());

      while (new Date(await time.latest() * 1000).getUTCDay() !== 0) {
        await time.increase(60 * 60 * 24);
      }

      // add to jdfiStakingPool

      let jdfisBalance = await jdfiStakingPool.balanceOf.call(jdfiStaker);
      await jdfiStakingPool.unstake(jdfisBalance, { from: jdfiStaker });

      await jdfiStakingPool.stake(amount, { from: jdfiStaker });

      // add to univ2StakingPool

      await jusdefi.mint(uniswapStaker, amount);

      let router = await IUniswapV2Router02.at(uniswapRouter);

      await router.addLiquidityETH(
        jusdefi.address,
        amount,
        amount,
        amount.div(new BN(4)),
        uniswapStaker,
        constants.MAX_UINT256,
        { from: uniswapStaker, value: amount.div(new BN(4)) }
      );

      let uniBalance = await pair.balanceOf.call(uniswapStaker);
      await pair.approve(univ2StakingPool.address, uniBalance, { from: uniswapStaker });
      await univ2StakingPool.methods['stake(uint256)'](uniBalance, { from: uniswapStaker });

      let initialJDFIStakerRewards = await jdfiStakingPool.rewardsOf.call(jdfiStaker);
      let initialUniswapStakerRewards = await univ2StakingPool.rewardsOf.call(uniswapStaker);

      await instance.rebase();

      let finalJDFIStakerRewards = await jdfiStakingPool.rewardsOf.call(jdfiStaker);
      let finalUniswapStakerRewards = await univ2StakingPool.rewardsOf.call(uniswapStaker);

      assert(!finalJDFIStakerRewards.sub(initialJDFIStakerRewards).isZero());

      // both pools have equal JDFI amount
      // UNIV2StakingPool earns 3x

      assert(
        finalJDFIStakerRewards.sub(initialJDFIStakerRewards).eq(
          finalUniswapStakerRewards.sub(initialUniswapStakerRewards).div(new BN(3))
        )
      );
    });

    it('sets weekly fee based on community vote', async function () {
      let one = new BN(web3.utils.toWei('1'));

      let base = new BN(1000);

      while (new Date(await time.latest() * 1000).getUTCDay() !== 0) {
        await time.increase(60 * 60 * 24);
      }

      await instance.vote(true, { from: NOBODY, value: one.mul(new BN(6)) });
      await instance.vote(false, { from: NOBODY, value: one.mul(new BN(5)) });
      await instance.rebase();
      assert((await instance._fee.call()).eq(base.add(new BN(250))));

      await time.increase(60 * 60 * 24 * 7);

      await instance.vote(true, { from: NOBODY, value: one.mul(new BN(2)) });
      await instance.vote(false, { from: NOBODY, value: one.mul(new BN(5)) });
      await instance.rebase();
      assert((await instance._fee.call()).eq(base.sub(new BN(500))));

      await time.increase(60 * 60 * 24 * 7);

      // no votes
      await instance.rebase();
      assert((await instance._fee.call()).eq(base));
    });

    it('resets votes', async function () {
      while (new Date(await time.latest() * 1000).getUTCDay() !== 0) {
        await time.increase(60 * 60 * 24);
      }

      let value = new BN(web3.utils.toWei('1'));
      await instance.vote(true, { from: NOBODY, value });
      await instance.vote(false, { from: NOBODY, value });

      await instance.rebase();

      assert((await instance._votesIncrease.call()).isZero());
      assert((await instance._votesDecrease.call()).isZero());
    });

    it('distributes no JDFI if staking pools are empty', async function () {
      let jdfiStakingPool = await JDFIStakingPool.at(await jusdefi._jdfiStakingPool.call());
      let univ2StakingPool = await UNIV2StakingPool.at(await jusdefi._univ2StakingPool.call());

      while (new Date(await time.latest() * 1000).getUTCDay() !== 0) {
        await time.increase(60 * 60 * 24);
      }

      await jdfiStakingPool.unstake(await jdfiStakingPool.balanceOf.call(DEPLOYER), { from: DEPLOYER });
      await jdfiStakingPool.unstake(await jdfiStakingPool.balanceOf.call(DEPOSITORS[0]), { from: DEPOSITORS[0] });

      assert((await jdfiStakingPool.totalSupply.call()).isZero());
      assert((await univ2StakingPool.totalSupply.call()).isZero());

      let initialBalance = await jusdefi.balanceOf.call(instance.address);
      await instance.rebase();
      let finalBalance = await jusdefi.balanceOf.call(instance.address);

      assert(!initialBalance.isZero());
      assert(initialBalance.eq(finalBalance));
    });

    describe('reverts if', function () {
      it('date is not Sunday (UTC)', async function () {
        if (new Date(await time.latest() * 1000).getUTCDay() === 0) {
          await time.increase(60 * 60 * 24);
        }

        await expectRevert(
          instance.rebase(),
          'JusDeFi: rebase must take place on Sunday (UTC)'
        );
      });

      it('last call was made within current day', async function () {
        while (new Date(await time.latest() * 1000).getUTCDay() !== 0) {
          await time.increase(60 * 60 * 24);
        }

        await instance.rebase();

        expectRevert(
          instance.rebase(),
          'JusDeFi: rebase already called this week'
        );
      });
    });
  });
});
