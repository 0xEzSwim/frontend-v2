import { flatten } from 'lodash';
import { UseInfiniteQueryOptions } from 'react-query/types';
import { computed, reactive, Ref, ref } from 'vue';
import { useInfiniteQuery } from 'vue-query';

import { POOLS } from '@/constants/pools';
import QUERY_KEYS from '@/constants/queryKeys';
import { Pool } from '@/services/pool/types';

import useApp from '../useApp';
import useNetwork from '../useNetwork';
import { lpTokensFor } from '../usePool';
import useTokens from '../useTokens';
import useUserSettings from '../useUserSettings';
import useGaugesQuery from './useGaugesQuery';
import { configService } from '@/services/config/config.service';
import {
  GraphQLArgs,
  GraphQLQuery,
  Op,
  PoolsBalancerAPIRepository,
  PoolsFallbackRepository,
  PoolsSubgraphRepository,
} from '@balancer-labs/sdk';
import { PoolDecorator } from '@/services/pool/decorators/pool.decorator';

type PoolsQueryResponse = {
  pools: Pool[];
  tokens: string[];
  skip?: number;
  enabled?: boolean;
};

type FilterOptions = {
  poolIds?: Ref<string[]>;
  poolAddresses?: Ref<string[]>;
  isExactTokensList?: boolean;
  pageSize?: number;
};

export default function usePoolsQuery(
  tokenList: Ref<string[]> = ref([]),
  options: UseInfiniteQueryOptions<PoolsQueryResponse> = {},
  filterOptions?: FilterOptions
) {
  /**
   * COMPOSABLES
   */
  const { injectTokens, prices, tokens: tokenMeta } = useTokens();
  const { currency } = useUserSettings();
  const { appLoading } = useApp();
  const { networkId } = useNetwork();
  const { data: subgraphGauges } = useGaugesQuery();
  const gaugeAddresses = computed(() =>
    (subgraphGauges.value || []).map(gauge => gauge.id)
  );

  /**
   * COMPUTED
   */
  const enabled = computed(() => !appLoading.value && options.enabled);

  /**
   * METHODS
   */

  function initializePoolsRepository() {
    const balancerApiRepository = initializeDecoratedAPIRepository();
    const subgraphRepository = initializeDecoratedSubgraphRepository();
    const fallbackRepository = new PoolsFallbackRepository(
      [balancerApiRepository, subgraphRepository],
      30 * 1000
    );
    return fallbackRepository;
  }

  function initializeDecoratedAPIRepository() {
    const balancerApiRepository = new PoolsBalancerAPIRepository(
      configService.network.balancerApi || '',
      configService.network.keys.balancerApi || ''
    );

    return {
      fetch: async (query: GraphQLQuery) => {
        const pools = await balancerApiRepository.fetch(query);

        return pools;
      },
    };
  }

  function initializeDecoratedSubgraphRepository() {
    const subgraphRepository = new PoolsSubgraphRepository(
      configService.network.subgraph
    );

    return {
      fetch: async (query: GraphQLQuery) => {
        const pools = await subgraphRepository.fetch(query);

        const poolDecorator = new PoolDecorator(pools);
        const decoratedPools = await poolDecorator.decorate(
          subgraphGauges.value || [],
          prices.value,
          currency.value,
          tokenMeta.value
        );

        return decoratedPools;
      },
    };
  }

  function getQueryArgs(pageParam = 0): GraphQLArgs {
    const tokensListFilterOperation = filterOptions?.isExactTokensList
      ? Op.Equals
      : Op.Contains;

    const queryArgs: any = {
      chainId: configService.network.chainId,
      first: 10,
      orderBy: 'totalLiquidity',
      orderDirection: 'desc',
      skip: pageParam,
      where: {
        tokensList: tokensListFilterOperation(tokenList.value),
        poolType: Op.NotIn(POOLS.ExcludedPoolTypes),
        totalShares: Op.GreaterThan(0.01),
        id: Op.NotIn(POOLS.BlockList),
      },
    };
    if (filterOptions?.poolIds?.value.length) {
      queryArgs.where.id = Op.In(filterOptions.poolIds.value);
    }
    if (filterOptions?.poolAddresses?.value.length) {
      queryArgs.where.address = Op.In(filterOptions.poolAddresses.value);
    }
    return queryArgs;
  }

  /**
   * QUERY KEY
   */
  const queryKey = QUERY_KEYS.Pools.All(
    networkId,
    tokenList,
    filterOptions?.poolIds,
    filterOptions?.poolAddresses,
    gaugeAddresses
  );

  const queryAttrs = {
    id: true,
    address: true,
    poolType: true,
    swapFee: true,
    tokensList: true,
    totalLiquidity: true,
    totalSwapVolume: true,
    totalSwapFee: true,
    totalShares: true,
    volumeSnapshot: true,
    owner: true,
    factory: true,
    amp: true,
    createTime: true,
    swapEnabled: true,
    tokens: {
      address: true,
      balance: true,
      weight: true,
      priceRate: true,
      symbol: true,
    },
    apr: {
      stakingApr: {
        min: true,
        max: true,
      },
      swapFees: true,
      tokenAprs: {
        total: true,
        breakdown: true,
      },
      rewardsApr: {
        total: true,
        breakdown: true,
      },
      protocolApr: true,
      min: true,
      max: true,
    },
  };

  /**
   * QUERY FUNCTION
   */
  const queryFn = async ({ pageParam = 0 }) => {
    const queryArgs = getQueryArgs(pageParam);
    const poolsRepository = initializePoolsRepository();

    console.log(
      'Fetching with Query Args: ',
      queryArgs,
      ' attrs: ',
      queryAttrs
    );
    const pools = await poolsRepository.fetch({
      args: queryArgs,
      attrs: queryAttrs,
    });

    const tokens = flatten(
      pools.map(pool => [
        ...pool.tokensList,
        ...lpTokensFor(pool),
        pool.address,
      ])
    );
    await injectTokens(tokens);

    console.log('RETRIEVED POOLS: ', pools);

    return {
      pools,
      tokens,
      skip: 0,
    };
  };

  const queryOptions = reactive({
    ...options,
    getNextPageParam: (lastPage: PoolsQueryResponse) => lastPage.skip,
    enabled,
  });

  return useInfiniteQuery<PoolsQueryResponse>(queryKey, queryFn, queryOptions);
}
